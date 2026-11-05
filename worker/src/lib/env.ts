export type Bindings = {
  DB: D1Database
  SCREENSHOTS: R2Bucket
  RUNNER_TOKEN: string
  HOOK_TOKEN: string
}

export type Project = {
  id: string
  key_hash: string
  repo_path: string
  base_branch: string
  harness: string
  permission: string
  model: string | null
  created_at: string
}

export type JobState = 'queued' | 'claimed' | 'running' | 'done' | 'blocked' | 'error'

export type JobRow = {
  id: string
  project_id: string
  report_json: string
  screenshot_key: string | null
  state: JobState
  session_id: string | null
  pr_url: string | null
  detail: string | null
  claimed_at: string | null
  created_at: string
  updated_at: string
}
