//! Reviewed, library-only subscriptions to public preset recipes.
use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{
    central_repo,
    error::AppError,
    git_fetcher, installer,
    repo_lock::RepoLock,
    skill_metadata,
    skill_store::{ScenarioRecord, SkillRecord, SkillStore},
    sync_metadata,
};
use crate::commands::skills::{
    git_source_from_skill, resolve_skill_dir, store_installed_skill_unlocked, InstallSourceMetadata,
};

const SETTINGS_KEY: &str = "followed_presets_v1";
const MAX_RECIPE_BYTES: usize = 262_144;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub name: String,
    pub description: Option<String>,
    pub skills: Vec<RecipeSkill>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecipeSkill {
    pub name: String,
    pub install_ref: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub source_url: String,
    pub revision: String,
    pub recipe: Recipe,
    pub preset_id: Option<String>,
    pub additions: Vec<String>,
    pub removals: Vec<String>,
    pub conflicts: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowedPreset {
    pub preset_id: String,
    pub name: String,
    pub source_url: String,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Subscription {
    #[serde(flatten)]
    followed: FollowedPreset,
    last_applied: Recipe,
    bindings: BTreeMap<String, String>,
    #[serde(default)]
    sources: BTreeMap<String, SourceIdentity>,
}

/// Keep validation ahead of URL parsing, which otherwise normalizes away `..`.
fn github_parts<'a>(value: &'a str, host: &str) -> Result<Vec<&'a str>, AppError> {
    let prefix = format!("https://{host}/");
    let path = value
        .strip_prefix(&prefix)
        .ok_or_else(|| AppError::invalid_input(format!("Expected a public HTTPS {host} URL")))?;
    if value.len() > 2048
        || path.split('/').any(|s| {
            s.is_empty()
                || s == "."
                || s == ".."
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
    {
        return Err(AppError::invalid_input(
            "URL contains unsupported or unsafe path components",
        ));
    }
    Ok(path.split('/').collect())
}

fn canonical_recipe_url(url: &str) -> Result<String, AppError> {
    let url = url.trim();
    let parts = if url.starts_with("https://github.com/") {
        let mut parts = github_parts(url, "github.com")?;
        if parts.len() < 5 || parts[2] != "blob" {
            return Err(AppError::invalid_input(
                "Use a GitHub blob or raw recipe URL",
            ));
        }
        parts.remove(2);
        parts
    } else {
        let parts = github_parts(url, "raw.githubusercontent.com")?;
        if parts.len() < 4 {
            return Err(AppError::invalid_input(
                "Use a GitHub blob or raw recipe URL",
            ));
        }
        parts
    };
    Ok(format!(
        "https://raw.githubusercontent.com/{}",
        parts.join("/")
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceIdentity {
    repo: String,
    branch: Option<String>,
    subpath: Option<String>,
}
fn install_source(reference: &str) -> Result<git_fetcher::ParsedGitSource, AppError> {
    git_fetcher::validate_git_url(reference).map_err(|e| AppError::invalid_input(e.to_string()))?;
    let parsed = git_fetcher::parse_git_source(reference);
    let parts = github_parts(&parsed.clone_url, "github.com")?;
    if parts.len() != 2 {
        return Err(AppError::invalid_input(
            "Recipe skills require a GitHub repository or tree URL",
        ));
    }
    // Validate the original tree tail as well as its parsed clone URL.
    if reference.starts_with("https://") {
        let original = github_parts(reference, "github.com")?;
        if original.len() != 2 && (original.len() < 4 || original[2] != "tree") {
            return Err(AppError::invalid_input(
                "Recipe skills require a GitHub repository or tree URL",
            ));
        }
    } else if reference.split('/').count() != 2 {
        return Err(AppError::invalid_input(
            "Recipe shorthand must be owner/repository",
        ));
    }
    Ok(git_fetcher::ParsedGitSource {
        branch: parsed.branch.filter(|branch| branch != "HEAD"),
        ..parsed
    })
}
fn identity(parsed: &git_fetcher::ParsedGitSource) -> SourceIdentity {
    SourceIdentity {
        repo: parsed
            .clone_url
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_ascii_lowercase(),
        branch: parsed.branch.clone(),
        subpath: parsed.subpath.clone(),
    }
}
struct SourceSet {
    skills: BTreeMap<String, SourceIdentity>,
    defaults: BTreeMap<String, String>,
}
fn resolve_sources(store: &SkillStore, recipe: &Recipe) -> Result<SourceSet, AppError> {
    let urls = recipe
        .skills
        .iter()
        .map(|s| s.install_ref.clone())
        .collect::<Vec<_>>();
    let resolved = git_fetcher::parse_git_sources_strict(&urls, store.proxy_url().as_deref(), None)
        .map_err(AppError::classify_git_error)?;
    let mut sources = SourceSet {
        skills: BTreeMap::new(),
        defaults: BTreeMap::new(),
    };
    for (entry, resolved) in recipe.skills.iter().zip(resolved) {
        let id = identity(&resolved.source);
        sources
            .defaults
            .insert(id.repo.clone(), resolved.default_branch);
        sources.skills.insert(name_key(&entry.name), id);
    }
    Ok(sources)
}
#[cfg(test)]
fn test_sources(recipe: &Recipe) -> Result<SourceSet, AppError> {
    Ok(SourceSet {
        skills: recipe
            .skills
            .iter()
            .map(|s| {
                Ok((
                    name_key(&s.name),
                    identity(&install_source(&s.install_ref)?),
                ))
            })
            .collect::<Result<_, AppError>>()?,
        defaults: BTreeMap::new(),
    })
}
fn matches_source(
    skill: &SkillRecord,
    wanted: &SourceIdentity,
    defaults: &BTreeMap<String, String>,
) -> bool {
    if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
        return false;
    }
    let Ok(source) = git_source_from_skill(skill) else {
        return false;
    };
    let repo = source
        .clone_url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    let current = SourceIdentity {
        branch: source
            .branch
            .filter(|s| s != "HEAD")
            .or_else(|| defaults.get(&repo).cloned()),
        repo,
        subpath: source.subpath.map(|path| path.replace('\\', "/")),
    };
    &current == wanted
}

fn name_key(name: &str) -> String {
    caseless::default_case_fold_str(&name.nfc().collect::<String>())
}
fn fresh_destination(store: &SkillStore, name: &str) -> Result<PathBuf, AppError> {
    let path = central_repo::skills_dir().join(name);
    match path.symlink_metadata() {
        Ok(_) => {
            return Err(AppError::invalid_input(format!(
                "{name}: library directory is already occupied"
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(AppError::io(error)),
    }
    if store
        .get_skill_by_central_path(&path.to_string_lossy())
        .map_err(AppError::db)?
        .is_some()
    {
        return Err(AppError::invalid_input(format!(
            "{name}: library directory is already owned"
        )));
    }
    Ok(path)
}
fn valid_existing_directory(skill: &SkillRecord) -> bool {
    let path = std::path::Path::new(&skill.central_path);
    path.symlink_metadata()
        .is_ok_and(|m| m.file_type().is_dir())
        && path
            .canonicalize()
            .ok()
            .zip(central_repo::skills_dir().canonicalize().ok())
            .is_some_and(|(path, root)| path != root && path.starts_with(root))
        && skill_metadata::is_valid_skill_dir(path)
}

fn decode_recipe(bytes: &[u8]) -> Result<(Recipe, String), AppError> {
    if bytes.len() > MAX_RECIPE_BYTES {
        return Err(AppError::invalid_input("Recipe exceeds 256 KiB"));
    }
    let recipe: Recipe =
        serde_json::from_slice(bytes).map_err(|e| AppError::invalid_input(e.to_string()))?;
    if recipe.name.trim().is_empty()
        || recipe.name.len() > 120
        || recipe.description.as_ref().is_some_and(|s| s.len() > 4000)
        || recipe.skills.len() > 256
    {
        return Err(AppError::invalid_input(
            "Invalid recipe name, description or skill count",
        ));
    }
    let mut names = HashSet::new();
    for skill in &recipe.skills {
        if skill.name.starts_with('.')
            || skill.name.len() > 120
            || skill_metadata::sanitize_skill_name(&skill.name).as_deref()
                != Some(skill.name.as_str())
            || !names.insert(name_key(&skill.name))
        {
            return Err(AppError::invalid_input(
                "Recipe contains an invalid or duplicate skill name",
            ));
        }
        install_source(&skill.install_ref)?;
    }
    Ok((recipe, format!("sha256:{:x}", Sha256::digest(bytes))))
}

fn fetch(store: &SkillStore, url: &str) -> Result<Vec<u8>, AppError> {
    let mut client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Skills-Manager-Followed-Presets");
    if let Some(proxy) = store.proxy_url() {
        client = client.proxy(reqwest::Proxy::all(proxy).map_err(AppError::network)?);
    }
    let response = client
        .build()
        .map_err(AppError::network)?
        .get(url)
        .send()
        .map_err(AppError::network)?
        .error_for_status()
        .map_err(AppError::network)?;
    if response.status().is_redirection() {
        return Err(AppError::network("Recipe redirects are not supported"));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RECIPE_BYTES as u64)
    {
        return Err(AppError::invalid_input("Recipe exceeds 256 KiB"));
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_RECIPE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(AppError::network)?;
    if bytes.len() > MAX_RECIPE_BYTES {
        return Err(AppError::invalid_input("Recipe exceeds 256 KiB"));
    }
    Ok(bytes)
}
fn subscriptions(store: &SkillStore) -> Result<Vec<Subscription>, AppError> {
    store
        .get_setting(SETTINGS_KEY)
        .map_err(AppError::db)?
        .map(|s| serde_json::from_str(&s).map_err(AppError::db))
        .unwrap_or_else(|| Ok(Vec::new()))
}
fn save(store: &SkillStore, subscriptions: &[Subscription]) -> Result<(), AppError> {
    store
        .set_setting(
            SETTINGS_KEY,
            &serde_json::to_string(subscriptions).map_err(AppError::db)?,
        )
        .map_err(AppError::db)
}

struct Plan {
    preview: Preview,
    subscription: Option<Subscription>,
    bindings: BTreeMap<String, String>,
    missing: Vec<RecipeSkill>,
}
fn plan(
    store: &SkillStore,
    url: &str,
    recipe: Recipe,
    revision: String,
    sources: &SourceSet,
) -> Result<Plan, AppError> {
    let followed = subscriptions(store)?;
    let subscription = followed
        .iter()
        .find(|s| s.followed.source_url == url)
        .cloned();
    let presets = store.get_all_scenarios().map_err(AppError::db)?;
    let preset_id = subscription
        .as_ref()
        .map(|s| s.followed.preset_id.clone())
        .or_else(|| {
            presets
                .iter()
                .find(|preset| preset.name == recipe.name)
                .map(|preset| preset.id.clone())
        });
    let mut conflicts = Vec::new();
    if let Some(id) = &preset_id {
        if !presets.iter().any(|preset| &preset.id == id) {
            conflicts.push(
                "Followed preset was deleted; unfollow this source before following again".into(),
            );
        }
        if followed
            .iter()
            .any(|other| &other.followed.preset_id == id && other.followed.source_url != url)
        {
            conflicts.push("This local preset already follows another source; unfollow it before attaching a different source".into());
        }
    }
    let members: HashSet<String> = preset_id
        .as_ref()
        .map(|id| store.get_skill_ids_for_scenario(id))
        .transpose()
        .map_err(AppError::db)?
        .unwrap_or_default()
        .into_iter()
        .collect();
    let all = store.get_all_skills().map_err(AppError::db)?;
    let previous: BTreeMap<String, &RecipeSkill> = subscription
        .as_ref()
        .map(|s| {
            s.last_applied
                .skills
                .iter()
                .map(|entry| (name_key(&entry.name), entry))
                .collect()
        })
        .unwrap_or_default();
    let mut bindings = BTreeMap::new();
    let mut missing = Vec::new();
    let mut additions = Vec::new();
    for entry in &recipe.skills {
        if let Some(before) = previous.get(&name_key(&entry.name)) {
            let previous_source = subscription
                .as_ref()
                .and_then(|s| s.sources.get(&name_key(&before.name)))
                .cloned()
                .unwrap_or(identity(&install_source(&before.install_ref)?));
            if Some(&previous_source) != sources.skills.get(&name_key(&entry.name)) {
                conflicts.push(format!(
                    "{}: publisher changed the install source",
                    entry.name
                ));
            }
        }
        let bound = subscription.as_ref().and_then(|s| {
            s.bindings.get(
                previous
                    .get(&name_key(&entry.name))
                    .map(|e| e.name.as_str())
                    .unwrap_or(&entry.name),
            )
        });
        let candidates: Vec<_> = all
            .iter()
            .filter(|s| Some(&s.id) == bound || name_key(&s.name) == name_key(&entry.name))
            .collect();
        let existing = if candidates.len() > 1 {
            conflicts.push(format!(
                "{}: multiple local skills have this name",
                entry.name
            ));
            None
        } else {
            candidates.first().copied()
        };
        if let Some(existing) = existing {
            if !matches_source(
                existing,
                &sources.skills[&name_key(&entry.name)],
                &sources.defaults,
            ) {
                conflicts.push(format!(
                    "{}: local skill has a different source",
                    entry.name
                ));
            }
            if !valid_existing_directory(existing) {
                conflicts.push(format!(
                    "{}: installed skill directory is missing or outside its library",
                    entry.name
                ));
            }
            bindings.insert(entry.name.clone(), existing.id.clone());
        }
        // Entries removed locally stay removed until the publisher removes and
        // later introduces them again. Unrelated local members remain intact.
        if !previous.contains_key(&name_key(&entry.name))
            && !existing.is_some_and(|s| members.contains(&s.id))
        {
            additions.push(entry.name.clone());
            if existing.is_none() {
                if let Err(error) = fresh_destination(store, &entry.name) {
                    conflicts.push(error.message);
                }
                missing.push(entry.clone());
            }
        }
    }
    let wanted: HashSet<_> = recipe.skills.iter().map(|s| name_key(&s.name)).collect();
    let removals = subscription
        .as_ref()
        .map(|s| {
            s.last_applied
                .skills
                .iter()
                .filter(|entry| {
                    !wanted.contains(&name_key(&entry.name))
                        && s.bindings.get(&entry.name).is_some_and(|id| {
                            members.contains(id)
                                && !bindings.values().any(|retained| retained == id)
                        })
                })
                .map(|s| s.name.clone())
                .collect()
        })
        .unwrap_or_default();
    Ok(Plan {
        preview: Preview {
            source_url: url.into(),
            revision,
            recipe,
            preset_id,
            additions,
            removals,
            conflicts,
        },
        subscription,
        bindings,
        missing,
    })
}
#[cfg(test)]
fn preview_bytes(store: &SkillStore, url: &str, bytes: &[u8]) -> Result<Preview, AppError> {
    let url = canonical_recipe_url(url)?;
    let (recipe, revision) = decode_recipe(bytes)?;
    let sources = test_sources(&recipe)?;
    let _lock = RepoLock::acquire_foreground("preview followed preset").map_err(AppError::db)?;
    Ok(plan(store, &url, recipe, revision, &sources)?.preview)
}
pub fn preview(store: &SkillStore, source_url: &str) -> Result<Preview, AppError> {
    let url = canonical_recipe_url(source_url)?;
    let (recipe, revision) = decode_recipe(&fetch(store, &url)?)?;
    let sources = resolve_sources(store, &recipe)?;
    let _lock = RepoLock::acquire_foreground("preview followed preset").map_err(AppError::db)?;
    Ok(plan(store, &url, recipe, revision, &sources)?.preview)
}

/// Rechecks conflicts under the library lock before invoking any installer.
fn apply_resolved_bytes<F>(
    store: &SkillStore,
    url: &str,
    bytes: &[u8],
    expected_revision: &str,
    sources: &SourceSet,
    mut install: F,
) -> Result<FollowedPreset, AppError>
where
    F: FnMut(&RecipeSkill) -> Result<String, AppError>,
{
    let url = canonical_recipe_url(url)?;
    let (recipe, revision) = decode_recipe(bytes)?;
    if revision != expected_revision {
        return Err(AppError::invalid_input(
            "Recipe changed since preview; review it again before applying",
        ));
    }
    let _lock = RepoLock::acquire_foreground("apply followed preset").map_err(AppError::db)?;
    let mut plan = plan(store, &url, recipe, revision, sources)?;
    if !plan.preview.conflicts.is_empty() {
        return Err(AppError::invalid_input(plan.preview.conflicts.join("; ")));
    }
    // Partial failures may leave successfully installed skills in the library,
    // but never advance membership or the subscription's approved baseline.
    for entry in &plan.missing {
        plan.bindings.insert(entry.name.clone(), install(entry)?);
    }
    let creating_new = plan.preview.preset_id.is_none();
    let preset_id = plan
        .preview
        .preset_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let original_members = if !creating_new {
        store
            .get_skill_ids_for_scenario(&preset_id)
            .map_err(AppError::db)?
    } else {
        Vec::new()
    };
    let result = (|| -> Result<FollowedPreset, AppError> {
        if creating_new {
            let now = chrono::Utc::now().timestamp_millis();
            store
                .insert_scenario(&ScenarioRecord {
                    id: preset_id.clone(),
                    name: plan.preview.recipe.name.clone(),
                    description: plan.preview.recipe.description.clone(),
                    icon: None,
                    sort_order: store.get_all_scenarios().map_err(AppError::db)?.len() as i32,
                    created_at: now,
                    updated_at: now,
                })
                .map_err(AppError::db)?;
        }
        for name in &plan.preview.additions {
            let id = plan.bindings.get(name).ok_or_else(|| {
                AppError::invalid_input(format!("Missing installed skill: {name}"))
            })?;
            store
                .add_skill_to_scenario(&preset_id, id)
                .map_err(AppError::db)?;
        }
        if let Some(before) = &plan.subscription {
            for name in &plan.preview.removals {
                if let Some(id) = before.bindings.get(name) {
                    store
                        .remove_skill_from_scenario(&preset_id, id)
                        .map_err(AppError::db)?;
                }
            }
        }
        sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        let followed = FollowedPreset {
            preset_id: preset_id.clone(),
            name: plan.preview.recipe.name.clone(),
            source_url: url.clone(),
            revision: plan.preview.revision.clone(),
        };
        let mut subscriptions = subscriptions(store)?;
        subscriptions.retain(|s| s.followed.source_url != url);
        subscriptions.push(Subscription {
            followed: followed.clone(),
            last_applied: plan.preview.recipe.clone(),
            bindings: plan.bindings.clone(),
            sources: sources.skills.clone(),
        });
        save(store, &subscriptions)?;
        Ok(followed)
    })();
    if let Err(error) = result {
        let rollback = (|| -> Result<(), AppError> {
            if creating_new {
                store.delete_scenario(&preset_id).map_err(AppError::db)?;
            } else {
                let current = store
                    .get_skill_ids_for_scenario(&preset_id)
                    .map_err(AppError::db)?;
                for id in current {
                    if !original_members.contains(&id) {
                        store
                            .remove_skill_from_scenario(&preset_id, &id)
                            .map_err(AppError::db)?;
                    }
                }
                for id in &original_members {
                    store
                        .add_skill_to_scenario(&preset_id, id)
                        .map_err(AppError::db)?;
                }
                store
                    .reorder_scenario_skills(&preset_id, &original_members)
                    .map_err(AppError::db)?;
            }
            if let Err(metadata_error) = sync_metadata::write_all_from_db_unlocked(store) {
                // An initial follow owns these UUID-named metadata files. Remove
                // only those files if a persistent disk error prevents rewrite.
                if creating_new {
                    let metadata = sync_metadata::metadata_dir();
                    let mut files =
                        vec![metadata.join("scenarios").join(format!("{preset_id}.json"))];
                    files.extend(plan.bindings.values().map(|id| {
                        metadata
                            .join("scenario-skills")
                            .join(&preset_id)
                            .join(format!("{id}.json"))
                    }));
                    for file in files {
                        match std::fs::remove_file(file) {
                            Ok(()) => (),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                            Err(e) => return Err(AppError::io(e)),
                        }
                    }
                }
                return Err(AppError::io(metadata_error));
            }
            Ok(())
        })();
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback) => AppError::io(format!(
                "{error}; restoring preset metadata failed: {rollback}"
            )),
        });
    }
    result
}

#[cfg(test)]
fn apply_bytes<F>(
    store: &SkillStore,
    url: &str,
    bytes: &[u8],
    expected_revision: &str,
    install: F,
) -> Result<FollowedPreset, AppError>
where
    F: FnMut(&RecipeSkill) -> Result<String, AppError>,
{
    let sources = test_sources(&decode_recipe(bytes)?.0)?;
    apply_resolved_bytes(store, url, bytes, expected_revision, &sources, install)
}

struct PreparedSkill {
    checkout: PathBuf,
    skill_dir: PathBuf,
    metadata: InstallSourceMetadata,
}
impl Drop for PreparedSkill {
    fn drop(&mut self) {
        git_fetcher::cleanup_temp(&self.checkout);
    }
}
fn prepare_skill(
    store: &SkillStore,
    entry: &RecipeSkill,
    resolved: &SourceIdentity,
) -> Result<PreparedSkill, AppError> {
    let mut source = install_source(&entry.install_ref)?;
    source.branch = resolved.branch.clone();
    source.subpath = resolved.subpath.clone();
    let checkout = git_fetcher::clone_repo_ref_scoped(
        &source.clone_url,
        source.branch.as_deref(),
        source.subpath.as_deref(),
        None,
        store.proxy_url().as_deref(),
        None,
    )
    .map_err(AppError::classify_git_error)?;
    let prepared = (|| {
        let dir = if source.subpath.is_none() {
            if !skill_metadata::is_valid_skill_dir(&checkout) {
                return Err(AppError::invalid_input("Repository root has no SKILL.md; use an explicit GitHub tree URL for a nested skill"));
            }
            checkout.clone()
        } else {
            resolve_skill_dir(&checkout, source.subpath.as_deref(), None)?
        };
        if !skill_metadata::is_valid_skill_dir(&dir) {
            return Err(AppError::invalid_input(
                "Install source does not contain SKILL.md",
            ));
        }
        let revision = git_fetcher::get_head_revision(&checkout).map_err(AppError::git)?;
        let metadata = InstallSourceMetadata {
            source_type: "git".into(),
            source_ref: Some(entry.install_ref.clone()),
            source_ref_resolved: Some(source.clone_url),
            source_subpath: git_fetcher::relative_subpath(&checkout, &dir)
                .map(|path| path.replace('\\', "/")),
            source_branch: source.branch,
            source_revision: Some(revision.clone()),
            remote_revision: Some(revision),
            update_status: "up_to_date".into(),
        };
        Ok((dir, metadata))
    })();
    match prepared {
        Ok((skill_dir, metadata)) => Ok(PreparedSkill {
            checkout,
            skill_dir,
            metadata,
        }),
        Err(error) => {
            git_fetcher::cleanup_temp(&checkout);
            Err(error)
        }
    }
}
pub fn apply(
    store: &SkillStore,
    source_url: &str,
    expected_revision: &str,
) -> Result<FollowedPreset, AppError> {
    let url = canonical_recipe_url(source_url)?;
    let bytes = fetch(store, &url)?;
    let (recipe, revision) = decode_recipe(&bytes)?;
    if revision != expected_revision {
        return Err(AppError::invalid_input(
            "Recipe changed since preview; review it again before applying",
        ));
    }
    let sources = resolve_sources(store, &recipe)?;
    let initial = {
        let _lock = RepoLock::acquire_foreground("plan followed preset").map_err(AppError::db)?;
        plan(store, &url, recipe, revision, &sources)?
    };
    if !initial.preview.conflicts.is_empty() {
        return Err(AppError::invalid_input(
            initial.preview.conflicts.join("; "),
        ));
    }
    // Network/cache work precedes the library lock. The plan is checked again
    // after reacquiring it, since another CLI or window may have edited skills.
    let mut prepared = BTreeMap::new();
    for entry in &initial.missing {
        prepared.insert(
            entry.name.clone(),
            prepare_skill(store, entry, &sources.skills[&name_key(&entry.name)])?,
        );
    }
    apply_resolved_bytes(store, &url, &bytes, expected_revision, &sources, |entry| {
        let source = prepared.get(&entry.name).ok_or_else(|| {
            AppError::invalid_input("Library changed during fetch; preview and apply again")
        })?;
        let destination = fresh_destination(store, &entry.name)?;
        let result = installer::install_skill_dir_to_destination(
            &source.skill_dir,
            &entry.name,
            &destination,
        )
        .map_err(AppError::io)?;
        store_installed_skill_unlocked(store, &result, &source.metadata, None)
    })
}
pub fn list(store: &SkillStore) -> Result<Vec<FollowedPreset>, AppError> {
    Ok(subscriptions(store)?
        .into_iter()
        .map(|s| s.followed)
        .collect())
}
pub fn unfollow(store: &SkillStore, source_url: &str) -> Result<(), AppError> {
    let url = canonical_recipe_url(source_url)?;
    let _lock = RepoLock::acquire_foreground("unfollow preset").map_err(AppError::db)?;
    let mut subscriptions = subscriptions(store)?;
    subscriptions.retain(|s| s.followed.source_url != url);
    save(store, &subscriptions)
}
pub fn export(store: &SkillStore, preset_id: &str) -> Result<Recipe, AppError> {
    let _lock = RepoLock::acquire_foreground("export preset recipe").map_err(AppError::db)?;
    let preset = store
        .get_all_scenarios()
        .map_err(AppError::db)?
        .into_iter()
        .find(|s| s.id == preset_id)
        .ok_or_else(|| AppError::not_found("Preset not found"))?;
    let mut skills = Vec::new();
    for skill in store
        .get_skills_for_scenario(preset_id)
        .map_err(AppError::db)?
    {
        if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
            return Err(AppError::invalid_input(format!(
                "{} has no portable GitHub install source",
                skill.name
            )));
        }
        let source = git_source_from_skill(&skill)?;
        if source.branch.as_ref().is_some_and(|branch| {
            branch.len() == 40 && branch.bytes().all(|c| c.is_ascii_hexdigit())
        }) {
            return Err(AppError::invalid_input(format!(
                "{}: pinned commit sources cannot be exported; use a branch or tag",
                skill.name
            )));
        }
        let repo = source
            .clone_url
            .trim_end_matches('/')
            .trim_end_matches(".git");
        let subpath = source
            .subpath
            .as_deref()
            .map(|path| path.replace('\\', "/"));
        let install_ref = match (source.branch.as_deref(), subpath.as_deref()) {
            (None, None) => repo.to_string(),
            (branch, subpath) => format!(
                "{repo}/tree/{}{}",
                branch.unwrap_or("HEAD"),
                subpath.map(|p| format!("/{p}")).unwrap_or_default()
            ),
        };
        install_source(&install_ref)?;
        skills.push(RecipeSkill {
            name: skill.name,
            install_ref,
        });
    }
    let recipe = Recipe {
        name: preset.name,
        description: preset.description,
        skills,
    };
    decode_recipe(&serde_json::to_vec(&recipe).map_err(AppError::db)?)?;
    Ok(recipe)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{central_repo, skill_store::SkillRecord, sync_metadata};
    const URL: &str = "https://github.com/team/presets/blob/main/team.json";
    struct TestRepo {
        _lock: std::sync::MutexGuard<'static, ()>,
        tmp: tempfile::TempDir,
        store: SkillStore,
    }
    impl Drop for TestRepo {
        fn drop(&mut self) {
            central_repo::set_test_base_dir_override(None);
        }
    }
    fn repo() -> TestRepo {
        let lock = central_repo::test_base_dir_lock();
        let tmp = tempfile::tempdir().unwrap();
        central_repo::set_test_base_dir_override(Some(tmp.path().to_path_buf()));
        std::fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        TestRepo {
            _lock: lock,
            tmp,
            store,
        }
    }
    fn recipe(names: &[&str]) -> Vec<u8> {
        serde_json::to_vec(&Recipe {
            name: "Team".into(),
            description: None,
            skills: names
                .iter()
                .map(|name| RecipeSkill {
                    name: name.to_string(),
                    install_ref: format!("https://github.com/team/skills/tree/main/skills/{name}"),
                })
                .collect(),
        })
        .unwrap()
    }
    fn seed(store: &SkillStore, name: &str) -> String {
        let path = central_repo::skills_dir().join(name);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
        let skill = SkillRecord {
            id: name.into(),
            name: name.into(),
            description: None,
            source_type: "git".into(),
            source_ref: Some(format!(
                "https://github.com/team/skills/tree/main/skills/{name}"
            )),
            source_ref_resolved: Some("https://github.com/team/skills".into()),
            source_subpath: Some(format!("skills/{name}")),
            source_branch: Some("main".into()),
            source_revision: None,
            remote_revision: None,
            central_path: path.to_string_lossy().into(),
            content_hash: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".into(),
            update_status: "up_to_date".into(),
            last_checked_at: None,
            last_check_error: None,
        };
        store.insert_skill(&skill).unwrap();
        name.into()
    }
    fn apply_test(store: &SkillStore, bytes: &[u8]) -> FollowedPreset {
        let revision = decode_recipe(bytes).unwrap().1;
        apply_bytes(store, URL, bytes, &revision, |_| {
            panic!("existing skill must be reused")
        })
        .unwrap()
    }
    #[test]
    fn reconciles_membership_preserves_customizations_and_persists() {
        let repo = repo();
        for name in ["a", "b", "c", "local"] {
            seed(&repo.store, name);
        }
        let followed = apply_test(&repo.store, &recipe(&["a", "b"]));
        repo.store
            .add_skill_to_scenario(&followed.preset_id, "local")
            .unwrap();
        repo.store
            .remove_skill_from_scenario(&followed.preset_id, "a")
            .unwrap();
        let bytes = recipe(&["a", "c"]);
        let preview = preview_bytes(&repo.store, URL, &bytes).unwrap();
        assert_eq!(preview.additions, vec!["c"]);
        assert_eq!(preview.removals, vec!["b"]);
        let updated = apply_test(&repo.store, &bytes);
        assert_eq!(updated.preset_id, followed.preset_id);
        let mut members = repo
            .store
            .get_skill_ids_for_scenario(&followed.preset_id)
            .unwrap();
        members.sort();
        assert_eq!(members, vec!["c", "local"]);
        apply_test(&repo.store, &bytes);
        assert_eq!(repo.store.get_all_scenarios().unwrap().len(), 1);
        assert!(repo.store.get_all_targets().unwrap().is_empty());
        assert_eq!(repo.store.get_all_skills().unwrap().len(), 4);
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap()
                .len(),
            2
        );
        let reopened = SkillStore::new(&repo.tmp.path().join("test.db")).unwrap();
        assert_eq!(list(&reopened).unwrap()[0].revision, updated.revision);
        unfollow(&reopened, URL).unwrap();
        assert!(list(&reopened).unwrap().is_empty());
        assert_eq!(
            reopened
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(reopened.get_all_skills().unwrap().len(), 4);
    }
    #[test]
    fn stale_revision_and_source_conflict_refuse_before_installs() {
        let repo = repo();
        seed(&repo.store, "a");
        let bytes = recipe(&["a"]);
        assert!(apply_bytes(&repo.store, URL, &bytes, "stale", |_| panic!(
            "must not install"
        ))
        .is_err());
        assert!(list(&repo.store).unwrap().is_empty());
        let followed = apply_test(&repo.store, &bytes);
        let mut changed: Recipe = serde_json::from_slice(&recipe(&["new", "a"])).unwrap();
        changed.skills[1].install_ref = "https://github.com/other/skills/tree/main/skills/a".into();
        let changed = serde_json::to_vec(&changed).unwrap();
        let preview = preview_bytes(&repo.store, URL, &changed).unwrap();
        assert!(!preview.conflicts.is_empty());
        assert!(apply_bytes(
            &repo.store,
            URL,
            &changed,
            &decode_recipe(&changed).unwrap().1,
            |_| panic!("conflicts precede all mutations")
        )
        .is_err());
        assert_eq!(list(&repo.store).unwrap()[0].revision, followed.revision);
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap(),
            vec!["a"]
        );
    }
    #[test]
    fn failed_missing_install_cannot_advance_baseline() {
        let repo = repo();
        seed(&repo.store, "a");
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        let bytes = recipe(&["a", "b", "c"]);
        let mut calls = 0;
        let result = apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |entry| {
                calls += 1;
                if entry.name == "c" {
                    Err(AppError::network("failed"))
                } else {
                    Ok(seed(&repo.store, &entry.name))
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(calls, 2);
        assert_eq!(list(&repo.store).unwrap()[0].revision, followed.revision);
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap(),
            vec!["a"]
        );
        assert!(repo.store.get_all_targets().unwrap().is_empty());
    }
    #[test]
    fn exports_portable_sources_and_rejects_local_imports() {
        let repo = repo();
        seed(&repo.store, "a");
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        assert_eq!(
            export(&repo.store, &followed.preset_id).unwrap().skills[0].install_ref,
            "https://github.com/team/skills/tree/main/skills/a"
        );
        let mut local = repo.store.get_skill_by_id("a").unwrap().unwrap();
        local.id = "local".into();
        local.name = "local".into();
        local.central_path = central_repo::skills_dir()
            .join("local")
            .to_string_lossy()
            .into();
        local.source_type = "import".into();
        repo.store.insert_skill(&local).unwrap();
        repo.store
            .add_skill_to_scenario(&followed.preset_id, "local")
            .unwrap();
        assert!(export(&repo.store, &followed.preset_id).is_err());
    }

    #[test]
    fn rejects_non_public_or_ambiguous_recipe_urls() {
        for url in [
            "http://github.com/a/b/blob/main/p.json",
            "https://example.com/p.json",
            "https://github.com@localhost/a/b/blob/main/p.json",
            "https://github.com/a/b/blob/main/../p.json",
            "https://raw.githubusercontent.com/a/b/main/p.json?token=x",
            "https://github.com/a/b/tree/main/p.json",
            "https://github.com:443/a/b/blob/main/p.json",
        ] {
            assert!(canonical_recipe_url(url).is_err(), "accepted {url}");
        }
        assert_eq!(
            canonical_recipe_url("https://github.com/a/b/blob/main/p.json").unwrap(),
            "https://raw.githubusercontent.com/a/b/main/p.json"
        );
    }
    #[test]
    fn validates_recipe_shape_names_sources_and_limits() {
        let valid = br#"{"name":"Team","skills":[{"name":"demo","install_ref":"a/b"}]}"#;
        assert_eq!(decode_recipe(valid).unwrap().0.skills.len(), 1);
        for invalid in [
            r#"{"name":"","skills":[]}"#,
            r#"{"name":"Team","skills":[{"name":"../escape","install_ref":"a/b"}]}"#,
            r#"{"name":"Team","skills":[{"name":"a","install_ref":"file:///tmp/repo"}]}"#,
            r#"{"name":"Team","skills":[{"name":"a","install_ref":"https://127.0.0.1/repo"}]}"#,
            r#"{"name":"Team","skills":[{"name":"a","install_ref":"a/b"},{"name":"a","install_ref":"a/c"}]}"#,
            r#"{"name":"Team","skills":[],"unknown":true}"#,
        ] {
            assert!(
                decode_recipe(invalid.as_bytes()).is_err(),
                "accepted {invalid}"
            );
        }
        assert!(decode_recipe(&vec![b' '; 262_145]).is_err());
        assert_ne!(
            decode_recipe(valid).unwrap().1,
            decode_recipe(format!("{} ", String::from_utf8_lossy(valid)).as_bytes())
                .unwrap()
                .1
        );
    }
    #[test]
    fn refuses_unowned_directories_before_any_install() {
        let repo = repo();
        let occupied = central_repo::skills_dir().join("blocked");
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::write(occupied.join("SKILL.md"), "same content").unwrap();
        let bytes = recipe(&["first", "blocked"]);
        assert!(!preview_bytes(&repo.store, URL, &bytes)
            .unwrap()
            .conflicts
            .is_empty());
        assert!(apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("preflight all occupied paths before installing")
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(occupied.join("SKILL.md")).unwrap(),
            "same content"
        );
        assert!(repo.store.get_all_skills().unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_dangling_library_symlink_before_install() {
        let repo = repo();
        let outside = repo.tmp.path().join("outside");
        std::os::unix::fs::symlink(&outside, central_repo::skills_dir().join("a")).unwrap();
        let bytes = recipe(&["a"]);
        assert!(!preview_bytes(&repo.store, URL, &bytes)
            .unwrap()
            .conflicts
            .is_empty());
        assert!(apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("must not follow dangling link")
        )
        .is_err());
        assert!(!outside.exists());
    }
    #[test]
    fn refuses_missing_or_ambiguously_named_existing_skills() {
        let repo = repo();
        seed(&repo.store, "a");
        std::fs::remove_dir_all(central_repo::skills_dir().join("a")).unwrap();
        assert!(!preview_bytes(&repo.store, URL, &recipe(&["a"]))
            .unwrap()
            .conflicts
            .is_empty());
        seed(&repo.store, "A");
        assert!(!preview_bytes(&repo.store, URL, &recipe(&["a"]))
            .unwrap()
            .conflicts
            .is_empty());
    }
    #[test]
    fn refuses_changed_source_after_local_record_deletion() {
        let repo = repo();
        seed(&repo.store, "a");
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        repo.store.delete_skill("a").unwrap();
        let mut changed: Recipe = serde_json::from_slice(&recipe(&["a"])).unwrap();
        changed.skills[0].install_ref = "https://github.com/other/skills/tree/main/skills/a".into();
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("baseline protects deleted records")
        )
        .is_err());
        assert_eq!(list(&repo.store).unwrap()[0].revision, followed.revision);
    }
    #[test]
    fn removed_members_keep_deployments_and_unchanged_members_keep_toggles() {
        let repo = repo();
        for name in ["a", "b"] {
            seed(&repo.store, name);
        }
        let followed = apply_test(&repo.store, &recipe(&["a", "b"]));
        repo.store
            .set_scenario_skill_tool_enabled(&followed.preset_id, "a", "test", false)
            .unwrap();
        let target = repo.tmp.path().join("deployed-b");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("user.txt"), "local edit").unwrap();
        repo.store
            .insert_target(&crate::core::skill_store::SkillTargetRecord {
                id: "target".into(),
                skill_id: "b".into(),
                tool: "test".into(),
                target_path: target.to_string_lossy().into(),
                mode: "copy".into(),
                status: "ok".into(),
                synced_at: None,
                last_error: None,
                source_hash: None,
            })
            .unwrap();
        apply_test(&repo.store, &recipe(&["a"]));
        assert_eq!(repo.store.get_all_targets().unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(target.join("user.txt")).unwrap(),
            "local edit"
        );
        assert!(
            !repo
                .store
                .get_scenario_skill_tool_toggles(&followed.preset_id, "a")
                .unwrap()[0]
                .enabled
        );
    }

    #[test]
    fn authoritative_branch_override_is_a_source_conflict() {
        let repo = repo();
        seed(&repo.store, "a");
        let mut changed = repo.store.get_skill_by_id("a").unwrap().unwrap();
        repo.store.delete_skill("a").unwrap();
        changed.source_branch = Some("other".into());
        repo.store.insert_skill(&changed).unwrap();
        assert!(!preview_bytes(&repo.store, URL, &recipe(&["a"]))
            .unwrap()
            .conflicts
            .is_empty());
    }
    #[test]
    fn case_only_recipe_rename_preserves_member() {
        let repo = repo();
        seed(&repo.store, "a");
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        let mut changed: Recipe = serde_json::from_slice(&recipe(&["a"])).unwrap();
        changed.skills[0].name = "A".into();
        apply_test(&repo.store, &serde_json::to_vec(&changed).unwrap());
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap(),
            vec!["a"]
        );
    }
    #[test]
    fn failed_initial_metadata_write_leaves_no_orphan_preset() {
        let repo = repo();
        seed(&repo.store, "a");
        let metadata = sync_metadata::metadata_dir();
        std::fs::create_dir_all(&metadata).unwrap();
        std::fs::write(
            metadata.join("scenario-skills"),
            "blocks membership metadata",
        )
        .unwrap();
        let bytes = recipe(&["a"]);
        assert!(apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("existing skill")
        )
        .is_err());
        assert!(list(&repo.store).unwrap().is_empty());
        assert!(repo.store.get_all_scenarios().unwrap().is_empty());
        std::fs::remove_file(metadata.join("scenario-skills")).unwrap();
        apply_test(&repo.store, &bytes);
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        assert_eq!(repo.store.get_all_scenarios().unwrap().len(), 1);
    }
    #[test]
    fn failed_subscription_save_rolls_back_curation_and_portable_metadata() {
        let repo = repo();
        seed(&repo.store, "a");
        seed(&repo.store, "b");
        let conn = rusqlite::Connection::open(repo.tmp.path().join("test.db")).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_follow BEFORE INSERT ON settings WHEN NEW.key = 'followed_presets_v1' BEGIN SELECT RAISE(ABORT, 'injected save failure'); END;").unwrap();
        let bytes = recipe(&["a"]);
        assert!(apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("existing")
        )
        .is_err());
        assert!(repo.store.get_all_scenarios().unwrap().is_empty());
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        assert!(repo.store.get_all_scenarios().unwrap().is_empty());
        conn.execute_batch("DROP TRIGGER fail_follow;").unwrap();
        let followed = apply_test(&repo.store, &bytes);
        conn.execute_batch("CREATE TRIGGER fail_follow BEFORE INSERT ON settings WHEN NEW.key = 'followed_presets_v1' BEGIN SELECT RAISE(ABORT, 'injected save failure'); END;").unwrap();
        let updated = recipe(&["b"]);
        assert!(apply_bytes(
            &repo.store,
            URL,
            &updated,
            &decode_recipe(&updated).unwrap().1,
            |_| panic!("existing")
        )
        .is_err());
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap(),
            vec!["a"]
        );
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap(),
            vec!["a"]
        );
        assert_eq!(list(&repo.store).unwrap()[0].revision, followed.revision);
    }
    #[test]
    fn resolves_default_branch_without_accepting_explicit_overrides() {
        let repo = repo();
        seed(&repo.store, "a");
        let mut skill = repo.store.get_skill_by_id("a").unwrap().unwrap();
        skill.source_branch = None;
        let wanted =
            identity(&install_source("https://github.com/team/skills/tree/main/skills/a").unwrap());
        let defaults = BTreeMap::from([(wanted.repo.clone(), "main".into())]);
        assert!(matches_source(&skill, &wanted, &defaults));
        skill.source_branch = Some("other".into());
        assert!(!matches_source(&skill, &wanted, &defaults));
        skill.source_branch = None;
        skill.source_ref = Some("https://github.com/team/skills".into());
        let root = SourceIdentity {
            subpath: None,
            ..wanted.clone()
        };
        assert!(
            !matches_source(&skill, &root, &defaults),
            "a source override must not be masked by its old root URL"
        );
    }
    #[test]
    fn rejects_pinned_commit_export_instead_of_emitting_uninstallable_recipe() {
        let repo = repo();
        seed(&repo.store, "a");
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        let mut skill = repo.store.get_skill_by_id("a").unwrap().unwrap();
        repo.store.delete_skill("a").unwrap();
        skill.source_branch = Some("1234567890123456789012345678901234567890".into());
        repo.store.insert_skill(&skill).unwrap();
        repo.store
            .add_skill_to_scenario(&followed.preset_id, "a")
            .unwrap();
        assert!(export(&repo.store, &followed.preset_id).is_err());
    }
    #[test]
    fn reuses_nested_library_directory_without_accepting_outside_paths() {
        let repo = repo();
        seed(&repo.store, "a");
        let original = central_repo::skills_dir().join("a");
        let nested = central_repo::skills_dir().join("nested").join("a");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::rename(&original, &nested).unwrap();
        let mut skill = repo.store.get_skill_by_id("a").unwrap().unwrap();
        repo.store.delete_skill("a").unwrap();
        skill.central_path = nested.to_string_lossy().into();
        repo.store.insert_skill(&skill).unwrap();
        assert!(preview_bytes(&repo.store, URL, &recipe(&["a"]))
            .unwrap()
            .conflicts
            .is_empty());
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        assert_eq!(
            repo.store
                .get_skill_ids_for_scenario(&followed.preset_id)
                .unwrap(),
            vec!["a"]
        );
        assert!(nested.join("SKILL.md").is_file());
        let outside = repo.tmp.path().join("outside");
        std::fs::rename(&nested, &outside).unwrap();
        repo.store.delete_skill("a").unwrap();
        skill.central_path = outside.to_string_lossy().into();
        repo.store.insert_skill(&skill).unwrap();
        assert!(!preview_bytes(&repo.store, URL, &recipe(&["a"]))
            .unwrap()
            .conflicts
            .is_empty());
        #[cfg(unix)]
        {
            let escape = central_repo::skills_dir().join("escape");
            std::os::unix::fs::symlink(repo.tmp.path(), &escape).unwrap();
            repo.store.delete_skill("a").unwrap();
            skill.central_path = escape.join("outside").to_string_lossy().into();
            repo.store.insert_skill(&skill).unwrap();
            assert!(!preview_bytes(&repo.store, URL, &recipe(&["a"]))
                .unwrap()
                .conflicts
                .is_empty());
        }
    }
    #[test]
    fn windows_source_subpaths_match_and_export_portable_urls() {
        let repo = repo();
        seed(&repo.store, "a");
        let mut skill = repo.store.get_skill_by_id("a").unwrap().unwrap();
        repo.store.delete_skill("a").unwrap();
        skill.source_subpath = Some(r"skills\a".into());
        repo.store.insert_skill(&skill).unwrap();
        assert!(preview_bytes(&repo.store, URL, &recipe(&["a"]))
            .unwrap()
            .conflicts
            .is_empty());
        let followed = apply_test(&repo.store, &recipe(&["a"]));
        assert_eq!(
            export(&repo.store, &followed.preset_id).unwrap().skills[0].install_ref,
            "https://github.com/team/skills/tree/main/skills/a"
        );
    }
    fn local_team_preset(store: &SkillStore) {
        store
            .insert_scenario(&ScenarioRecord {
                id: "existing".into(),
                name: "Team".into(),
                description: Some("Local description".into()),
                icon: Some("local-icon".into()),
                sort_order: 3,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
    }
    #[test]
    fn initial_follow_attaches_existing_named_preset_and_preserves_local_state() {
        let repo = repo();
        for name in ["a", "b", "local"] {
            seed(&repo.store, name);
        }
        local_team_preset(&repo.store);
        repo.store.add_skill_to_scenario("existing", "a").unwrap();
        repo.store
            .add_skill_to_scenario("existing", "local")
            .unwrap();
        repo.store
            .set_scenario_skill_tool_enabled("existing", "a", "test", false)
            .unwrap();
        repo.store.set_active_scenario("existing").unwrap();
        let bytes = recipe(&["a", "b"]);
        let preview = preview_bytes(&repo.store, URL, &bytes).unwrap();
        assert_eq!(preview.preset_id.as_deref(), Some("existing"));
        assert!(preview.conflicts.is_empty());
        assert_eq!(preview.additions, vec!["b"]);
        let followed = apply_test(&repo.store, &bytes);
        assert_eq!(followed.preset_id, "existing");
        assert_eq!(repo.store.get_all_scenarios().unwrap().len(), 1);
        let mut members = repo.store.get_skill_ids_for_scenario("existing").unwrap();
        members.sort();
        assert_eq!(members, vec!["a", "b", "local"]);
        let preset = &repo.store.get_all_scenarios().unwrap()[0];
        assert_eq!(preset.description.as_deref(), Some("Local description"));
        assert_eq!(preset.icon.as_deref(), Some("local-icon"));
        assert_eq!(preset.sort_order, 3);
        assert!(
            !repo
                .store
                .get_scenario_skill_tool_toggles("existing", "a")
                .unwrap()[0]
                .enabled
        );
        assert_eq!(
            repo.store.get_active_scenario_id().unwrap().as_deref(),
            Some("existing")
        );
        assert!(repo.store.get_all_targets().unwrap().is_empty());
        let other = "https://github.com/other/presets/blob/main/team.json";
        assert!(!preview_bytes(&repo.store, other, &bytes)
            .unwrap()
            .conflicts
            .is_empty());
        assert!(apply_bytes(
            &repo.store,
            other,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("another subscription owns this preset")
        )
        .is_err());
    }
    #[test]
    fn failed_initial_attach_restores_existing_preset_and_membership() {
        let repo = repo();
        for name in ["a", "local"] {
            seed(&repo.store, name);
        }
        local_team_preset(&repo.store);
        repo.store
            .add_skill_to_scenario("existing", "local")
            .unwrap();
        let conn = rusqlite::Connection::open(repo.tmp.path().join("test.db")).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_follow BEFORE INSERT ON settings WHEN NEW.key = 'followed_presets_v1' BEGIN SELECT RAISE(ABORT, 'injected save failure'); END;").unwrap();
        let bytes = recipe(&["a"]);
        let error = apply_bytes(
            &repo.store,
            URL,
            &bytes,
            &decode_recipe(&bytes).unwrap().1,
            |_| panic!("existing"),
        )
        .unwrap_err();
        assert!(error.message.contains("injected save failure"), "{error}");
        assert_eq!(repo.store.get_all_scenarios().unwrap().len(), 1);
        assert_eq!(
            repo.store.get_skill_ids_for_scenario("existing").unwrap(),
            vec!["local"]
        );
        assert!(list(&repo.store).unwrap().is_empty());
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        assert_eq!(
            repo.store.get_skill_ids_for_scenario("existing").unwrap(),
            vec!["local"]
        );
    }
}
