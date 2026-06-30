import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Paste-a-workflow analyzer.
//
// Endpoints accept raw CI workflow source (GitHub Actions YAML, GitLab CI, or
// a Jenkinsfile) and return a normalized model and an inline least-privilege /
// risk analysis. Nothing is persisted — these are pure, request-scoped
// computations over the pasted text.
//
// The parser is intentionally dependency-free and indentation-aware enough to
// extract the structures we reason about (jobs, steps, permissions, `uses`
// actions, and referenced secrets) from real-world GitHub Actions YAML, with
// best-effort fallbacks for GitLab CI and Jenkinsfiles.
// ---------------------------------------------------------------------------

type Provider = 'github_actions' | 'gitlab_ci' | 'jenkins' | 'unknown'

interface NormalizedStep {
  job: string
  name: string
  uses: string
  run: string
}

interface NormalizedAction {
  /** Full `owner/repo` (without ref). */
  name: string
  /** Pinned reference: a tag, branch, or 40-char sha (empty if none). */
  ref: string
  /** tag | branch | sha | none */
  pinType: 'tag' | 'branch' | 'sha' | 'none'
  /** Job the action is referenced from. */
  job: string
}

interface NormalizedModel {
  provider: Provider
  jobs: string[]
  steps: NormalizedStep[]
  /**
   * Declared permissions, normalized to a flat scope->level map.
   * `{ "*": "write" }` represents the `permissions: write-all` shorthand.
   */
  permissions: Record<string, string>
  uses: NormalizedAction[]
  secrets: string[]
}

interface InlineFinding {
  detector: string
  title: string
  description: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  evidence: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/i
const COMMON_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'release'])

function indentOf(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return i
}

function stripComment(line: string): string {
  // Remove trailing `# ...` comments that are not inside quotes (best effort).
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i)
    }
  }
  return line
}

function unquote(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

function detectProvider(src: string): Provider {
  const lower = src.toLowerCase()
  if (/^\s*pipeline\s*\{/m.test(src) || /\bstages?\s*\{/m.test(src) || src.includes('sh ')) {
    if (/\bpipeline\s*\{/.test(src) || /\bagent\b/.test(src)) return 'jenkins'
  }
  if (/^\s*jobs:/m.test(src) || /\buses:\s*/.test(src) || /runs-on:/.test(src)) return 'github_actions'
  if (/^\s*stages:/m.test(lower) || /\bscript:/.test(lower) || /\bimage:/.test(lower)) return 'gitlab_ci'
  return 'unknown'
}

function classifyPin(ref: string): NormalizedAction['pinType'] {
  if (!ref) return 'none'
  if (SHA_RE.test(ref)) return 'sha'
  if (COMMON_BRANCHES.has(ref.toLowerCase())) return 'branch'
  // A leading 'v' or a dotted version reads as a tag.
  if (/^v?\d/.test(ref)) return 'tag'
  // Heuristic: short, non-version refs that look like branch names.
  if (/^[a-z][\w/-]*$/i.test(ref) && !/\d/.test(ref)) return 'branch'
  return 'tag'
}

function collectSecrets(src: string): string[] {
  const found = new Set<string>()
  // GitHub Actions: ${{ secrets.NAME }}
  const gh = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = gh.exec(src)) !== null) found.add(m[1])
  // GitLab / generic env-style secret variables ($VAR or ${VAR}) that look
  // like secrets (contain TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL).
  const env = /\$\{?([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL|CREDS)[A-Z0-9_]*)\}?/g
  while ((m = env.exec(src)) !== null) found.add(m[1])
  // Jenkins: credentials('id') / withCredentials
  const jenkins = /credentials\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = jenkins.exec(src)) !== null) found.add(m[1])
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// Core parser — extracts the normalized model from pasted source.
// ---------------------------------------------------------------------------

function parseWorkflow(src: string): NormalizedModel {
  const provider = detectProvider(src)
  const rawLines = src.split(/\r?\n/)

  const jobsSet = new Set<string>()
  const steps: NormalizedStep[] = []
  const permissions: Record<string, string> = {}
  const usesList: NormalizedAction[] = []

  let inJobs = false
  let jobsIndent = -1
  let currentJob = ''
  let currentJobIndent = -1

  // Permissions block tracking.
  let inPermsBlock = false
  let permsIndent = -1

  // Step accumulation (GitHub Actions `steps:` lists).
  let pendingStep: NormalizedStep | null = null

  const flushStep = () => {
    if (pendingStep && (pendingStep.uses || pendingStep.run || pendingStep.name)) {
      steps.push(pendingStep)
      if (pendingStep.uses) {
        const [name, ref = ''] = pendingStep.uses.split('@')
        if (name.includes('/')) {
          usesList.push({ name, ref, pinType: classifyPin(ref), job: pendingStep.job })
        }
      }
    }
    pendingStep = null
  }

  for (let idx = 0; idx < rawLines.length; idx++) {
    const original = rawLines[idx]
    const line = stripComment(original)
    if (line.trim().length === 0) continue
    const indent = indentOf(line)
    const trimmed = line.trim()

    // --- top-level keys ---
    if (indent === 0) {
      flushStep()
      inJobs = false
      inPermsBlock = false
      currentJob = ''
      if (/^jobs:\s*$/.test(trimmed)) {
        inJobs = true
        jobsIndent = 0
        continue
      }
      // Workflow-level permissions.
      const permTop = /^permissions:\s*(.*)$/.exec(trimmed)
      if (permTop) {
        const inline = unquote(permTop[1])
        if (inline === 'write-all') permissions['*'] = 'write'
        else if (inline === 'read-all') permissions['*'] = 'read'
        else if (inline.length === 0) {
          inPermsBlock = true
          permsIndent = indent
        }
        continue
      }
      continue
    }

    // --- inside a permissions: block (scope: level lines) ---
    if (inPermsBlock) {
      if (indent <= permsIndent) {
        inPermsBlock = false
      } else {
        const pm = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(trimmed)
        if (pm) {
          permissions[pm[1]] = unquote(pm[2])
          continue
        }
      }
    }

    // --- job declarations (one indent level under jobs:) ---
    if (inJobs) {
      if (jobsIndent < 0 || indent > jobsIndent) {
        if (currentJob === '' || indent <= currentJobIndent) {
          const jm = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed)
          if (jm && (currentJobIndent < 0 || indent <= currentJobIndent)) {
            flushStep()
            currentJob = jm[1]
            currentJobIndent = indent
            jobsSet.add(currentJob)
            continue
          }
        }
      }

      // Per-job permissions block.
      const jobPerm = /^permissions:\s*(.*)$/.exec(trimmed)
      if (jobPerm && currentJob) {
        const inline = unquote(jobPerm[1])
        if (inline === 'write-all') permissions['*'] = 'write'
        else if (inline === 'read-all') permissions['*'] = permissions['*'] ?? 'read'
        else if (inline.length === 0) {
          inPermsBlock = true
          permsIndent = indent
        }
        continue
      }

      // Steps: a list item starting a new step.
      if (currentJob) {
        const usesInline = /^-?\s*uses:\s*(.+)$/.exec(trimmed)
        const runInline = /^-?\s*run:\s*(.*)$/.exec(trimmed)
        const nameInline = /^-?\s*name:\s*(.+)$/.exec(trimmed)
        const isListItem = /^-\s/.test(trimmed) || trimmed === '-'

        if (isListItem) {
          flushStep()
          pendingStep = { job: currentJob, name: '', uses: '', run: '' }
        }

        if (usesInline) {
          if (!pendingStep) pendingStep = { job: currentJob, name: '', uses: '', run: '' }
          pendingStep.uses = unquote(usesInline[1])
          continue
        }
        if (runInline) {
          if (!pendingStep) pendingStep = { job: currentJob, name: '', uses: '', run: '' }
          pendingStep.run = unquote(runInline[1])
          continue
        }
        if (nameInline) {
          if (!pendingStep) pendingStep = { job: currentJob, name: '', uses: '', run: '' }
          pendingStep.name = unquote(nameInline[1])
          continue
        }
      }
    }
  }
  flushStep()

  // GitLab CI fallback: jobs are top-level keys with a `script:` child; stages
  // listed under `stages:`. Best-effort when no GitHub jobs were detected.
  if (provider === 'gitlab_ci' && jobsSet.size === 0) {
    for (const original of rawLines) {
      const line = stripComment(original)
      if (line.trim().length === 0) continue
      if (indentOf(line) === 0) {
        const km = /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim())
        if (km && !['stages', 'variables', 'default', 'include', 'workflow'].includes(km[1])) {
          jobsSet.add(km[1])
        }
      }
    }
  }

  // Jenkins fallback: stage('Name') blocks become "jobs".
  if (provider === 'jenkins' && jobsSet.size === 0) {
    const stageRe = /stage\(\s*['"]([^'"]+)['"]\s*\)/g
    let sm: RegExpExecArray | null
    while ((sm = stageRe.exec(src)) !== null) jobsSet.add(sm[1])
  }

  const secrets = collectSecrets(src)

  return {
    provider,
    jobs: [...jobsSet],
    steps,
    permissions,
    uses: usesList,
    secrets,
  }
}

// ---------------------------------------------------------------------------
// Least-privilege + risk analysis over a normalized model.
// ---------------------------------------------------------------------------

/** Map a `run:` command corpus to the GitHub permission scopes it needs. */
function inferRequiredPermissions(model: NormalizedModel): Record<string, string> {
  const required: Record<string, string> = {}
  const runCorpus = model.steps.map((s) => s.run).join('\n').toLowerCase()
  const usesNames = model.uses.map((u) => u.name.toLowerCase())

  const needsWrite = (scope: string) => {
    required[scope] = 'write'
  }
  const needsRead = (scope: string) => {
    if (required[scope] !== 'write') required[scope] = 'read'
  }

  // contents: write if pushing/tagging/releasing; otherwise read for checkout.
  if (/git\s+push|gh\s+release|softprops\/action-gh-release/.test(runCorpus + usesNames.join(' '))) {
    needsWrite('contents')
  } else if (usesNames.some((n) => n.includes('actions/checkout')) || /git\s+(clone|fetch|checkout)/.test(runCorpus)) {
    needsRead('contents')
  }

  // packages: write when publishing to a registry.
  if (/docker\s+push|npm\s+publish|gh.*package|ghcr\.io|registry/.test(runCorpus)) needsWrite('packages')

  // pull-requests / issues writes.
  if (/gh\s+pr\s+(comment|create|edit|merge)|pull-request|create-pull-request/.test(runCorpus + usesNames.join(' '))) {
    needsWrite('pull-requests')
  }
  if (/gh\s+issue\s+(create|comment|edit)/.test(runCorpus)) needsWrite('issues')

  // id-token: write for OIDC cloud auth.
  if (/aws-actions\/configure-aws-credentials|azure\/login|google-github-actions\/auth|id-token/.test(usesNames.join(' ') + runCorpus)) {
    needsWrite('id-token')
  }

  // deployments.
  if (/deployment|deploy/.test(runCorpus)) needsRead('deployments')

  // Default: a workflow that only reads code needs contents:read.
  if (Object.keys(required).length === 0) needsRead('contents')

  return required
}

function scoreFinding(sev: InlineFinding['severity']): number {
  return sev === 'critical' ? 40 : sev === 'high' ? 25 : sev === 'medium' ? 12 : 4
}

function analyzeWorkflow(model: NormalizedModel): {
  findings: InlineFinding[]
  risk_score: number
  recommended_permissions: Record<string, string>
} {
  const findings: InlineFinding[] = []
  const declared = model.permissions

  // 1. write-all / wildcard write permissions.
  if (declared['*'] === 'write') {
    findings.push({
      detector: 'over_privilege',
      title: 'Workflow grants write-all permissions',
      description:
        'The workflow declares `permissions: write-all` (or a `*: write` equivalent), granting every GITHUB_TOKEN scope write access. Scope permissions to only what each job needs.',
      severity: 'high',
      evidence: { declared },
    })
  } else if (Object.keys(declared).length === 0) {
    findings.push({
      detector: 'over_privilege',
      title: 'No explicit permissions block',
      description:
        'No `permissions:` block was found. The workflow inherits the repository/organization default token scopes, which are frequently broader than required. Declare an explicit least-privilege block.',
      severity: 'medium',
      evidence: {},
    })
  }

  // 2. Unpinned third-party actions (tag/branch instead of sha).
  for (const u of model.uses) {
    // First-party actions/* are lower risk but still flagged when branch-pinned.
    const firstParty = u.name.toLowerCase().startsWith('actions/') || u.name.toLowerCase().startsWith('github/')
    if (u.pinType === 'branch') {
      findings.push({
        detector: 'action_risk',
        title: `Action ${u.name} pinned to a mutable branch`,
        description: `\`${u.name}@${u.ref}\` is pinned to a branch, which is mutable and can be force-updated to malicious code. Pin to a full commit SHA.`,
        severity: firstParty ? 'medium' : 'high',
        evidence: { action: u.name, ref: u.ref, job: u.job, pin_type: u.pinType },
      })
    } else if (u.pinType === 'tag' && !firstParty) {
      findings.push({
        detector: 'action_risk',
        title: `Third-party action ${u.name} pinned to a tag`,
        description: `\`${u.name}@${u.ref}\` is pinned to a tag. Tags are mutable in Git; a compromised maintainer can repoint the tag. Pin third-party actions to a full commit SHA.`,
        severity: 'medium',
        evidence: { action: u.name, ref: u.ref, job: u.job, pin_type: u.pinType },
      })
    } else if (u.pinType === 'none') {
      findings.push({
        detector: 'action_risk',
        title: `Action ${u.name} has no version pin`,
        description: `\`${u.name}\` is referenced without any \`@ref\`, resolving to the default branch. Pin to a full commit SHA.`,
        severity: firstParty ? 'medium' : 'high',
        evidence: { action: u.name, job: u.job, pin_type: u.pinType },
      })
    }
  }

  // 3. Excess declared scopes vs inferred need.
  const recommended = inferRequiredPermissions(model)
  if (declared['*'] !== 'write') {
    for (const [scope, level] of Object.entries(declared)) {
      if (scope === '*') continue
      const need = recommended[scope]
      if (level === 'write' && need !== 'write') {
        findings.push({
          detector: 'over_privilege',
          title: `Excess permission: ${scope}: write`,
          description: `The workflow declares \`${scope}: write\` but no step appears to require write access to ${scope}. Downgrade to \`${need ?? 'none'}\`.`,
          severity: 'medium',
          evidence: { scope, declared_level: level, recommended_level: need ?? 'none' },
        })
      }
    }
  }

  // 4. Secrets referenced — flag potential fork-PR exposure on pull_request_target-like patterns.
  if (model.secrets.length > 0) {
    findings.push({
      detector: 'secret',
      title: `${model.secrets.length} secret reference(s) used in workflow`,
      description:
        'Secrets are referenced in this workflow. Ensure they are masked, scoped to the minimum jobs, and never exposed to workflows triggered by forked pull requests.',
      severity: 'low',
      evidence: { secrets: model.secrets },
    })
  }

  // 5. Inline curl|bash / pipe-to-shell supply-chain smell.
  const runCorpus = model.steps.map((s) => s.run).join('\n')
  if (/curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh/i.test(runCorpus) || /wget[^\n|]*\|\s*(ba)?sh/i.test(runCorpus)) {
    findings.push({
      detector: 'action_risk',
      title: 'Pipe-to-shell of remote script',
      description:
        'A step pipes a downloaded script directly into a shell (`curl ... | bash`). This executes unverified remote code. Download, checksum, then run.',
      severity: 'high',
      evidence: {},
    })
  }

  // Risk score: capped 0-100, monotonic in severity-weighted finding count.
  const raw = findings.reduce((acc, f) => acc + scoreFinding(f.severity), 0)
  const risk_score = Math.min(100, raw)

  // Order findings by severity (most severe first), then by detector.
  const sevRank: Record<InlineFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 }
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.detector.localeCompare(b.detector))

  return { findings, risk_score, recommended_permissions: recommended }
}

// ---------------------------------------------------------------------------
// Routes (auth-gated; no persistence).
// ---------------------------------------------------------------------------

const sourceSchema = z.object({
  source: z.string().min(1, 'source is required'),
})

router.post('/parse', authMiddleware, zValidator('json', sourceSchema), async (c) => {
  const { source } = c.req.valid('json')
  const model = parseWorkflow(source)
  return c.json(model)
})

router.post('/analyze', authMiddleware, zValidator('json', sourceSchema), async (c) => {
  const { source } = c.req.valid('json')
  const model = parseWorkflow(source)
  const analysis = analyzeWorkflow(model)
  return c.json({ model, ...analysis })
})

export default router
