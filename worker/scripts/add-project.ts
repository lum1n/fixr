/**
 * Registers a project: generates a random project key, prints it once, and
 * inserts its sha256 hash with the repo settings into D1 via
 * `wrangler d1 execute`.
 *
 *   pnpm add-project --id notes --repo-path ~/repos/notes \
 *     [--base-branch main] [--harness claude] [--permission bypassPermissions] [--model opus] \
 *     [--local | --remote] [--database fixr] [--print-sql]
 *
 * `--local` (default) targets the `wrangler dev` database, `--remote` the
 * deployed one. `--print-sql` only prints the SQL and the key.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    'repo-path': { type: 'string' },
    'base-branch': { type: 'string', default: 'main' },
    harness: { type: 'string', default: 'claude' },
    permission: { type: 'string', default: 'bypassPermissions' },
    model: { type: 'string' },
    database: { type: 'string', default: 'fixr' },
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    'print-sql': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`)
  console.error(
    'usage: pnpm add-project --id <id> --repo-path <path> [--base-branch main] [--harness claude]\n' +
      '         [--permission bypassPermissions] [--model <model>] [--local|--remote] [--database fixr] [--print-sql]',
  )
  process.exit(message ? 64 : 0)
}

if (values.help) usage()
const id = values.id
const repoPath = values['repo-path']
if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) usage('--id is required: lowercase letters, digits, - and _')
if (!repoPath) usage('--repo-path is required')
if (values.local && values.remote) usage('pass only one of --local and --remote')

const sqlString = (value: string | undefined) => (value === undefined ? 'NULL' : `'${value.replaceAll("'", "''")}'`)

const key = `fixr_${randomBytes(32).toString('base64url')}`
const keyHash = createHash('sha256').update(key).digest('hex')
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const sql =
  'INSERT INTO projects (id, key_hash, repo_path, base_branch, harness, permission, model, created_at) VALUES (' +
  [id, keyHash, repoPath, values['base-branch'], values.harness, values.permission, values.model, now]
    .map(sqlString)
    .join(', ') +
  ');'

if (values['print-sql']) {
  console.log(sql)
} else {
  const target = values.remote ? '--remote' : '--local'
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', values.database, target, '--command', sql], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  if (result.status !== 0) {
    console.error('\nwrangler d1 execute failed; no project was added and the key was discarded.')
    process.exit(result.status ?? 1)
  }
}

console.log(`\nProject key for "${id}" (shown once, store it in the app's config):\n\n  ${key}\n`)
