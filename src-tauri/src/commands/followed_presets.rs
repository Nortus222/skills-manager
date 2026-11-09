use crate::core::{
    error::AppError,
    followed_presets::{self, FollowedPreset, Preview, Recipe},
    skill_store::SkillStore,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn preview_followed_preset(
    source_url: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<Preview, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || followed_presets::preview(&store, &source_url))
        .await?
}
#[tauri::command]
pub async fn apply_followed_preset(
    source_url: String,
    expected_revision: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<FollowedPreset, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        followed_presets::apply(&store, &source_url, &expected_revision)
    })
    .await?
}
#[tauri::command]
pub async fn get_followed_presets(
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<FollowedPreset>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || followed_presets::list(&store)).await?
}
#[tauri::command]
pub async fn unfollow_preset(
    source_url: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || followed_presets::unfollow(&store, &source_url))
        .await?
}
#[tauri::command]
pub async fn export_preset_recipe(
    preset_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<Recipe, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || followed_presets::export(&store, &preset_id))
        .await?
}
