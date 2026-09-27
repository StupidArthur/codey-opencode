import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UiPreferences } from '../../shared/contracts'

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  sidebarCollapsed: false,
  runnerOpen: false,
  specPaneRatio: 0.42
}

export class UiPreferencesStore {
  readonly filePath: string

  constructor(filePath = join(homedir(), '.codey', 'config.json')) {
    this.filePath = filePath
  }

  load(): UiPreferences {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return normalizePreferences(parsed)
    } catch {
      return { ...DEFAULT_UI_PREFERENCES }
    }
  }

  save(preferences: UiPreferences): UiPreferences {
    const normalized = normalizePreferences(preferences)
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp`
    writeFileSync(temp, JSON.stringify({ workspace: normalized }, null, 2) + '\n', 'utf8')
    renameSync(temp, this.filePath)
    return normalized
  }
}

function normalizePreferences(value: unknown): UiPreferences {
  const root = isRecord(value) && isRecord(value.workspace) ? value.workspace : value
  const source = isRecord(root) ? root : {}
  const ratio = typeof source.specPaneRatio === 'number' && Number.isFinite(source.specPaneRatio)
    ? source.specPaneRatio
    : DEFAULT_UI_PREFERENCES.specPaneRatio

  return {
    sidebarCollapsed: typeof source.sidebarCollapsed === 'boolean'
      ? source.sidebarCollapsed
      : DEFAULT_UI_PREFERENCES.sidebarCollapsed,
    runnerOpen: typeof source.runnerOpen === 'boolean'
      ? source.runnerOpen
      : DEFAULT_UI_PREFERENCES.runnerOpen,
    specPaneRatio: Math.max(0.25, Math.min(0.7, ratio))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
