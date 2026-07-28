/**
 * Stack presets for `branchdeck init`.
 *
 * Detection is deliberately conservative: when the shape of a project is not
 * obvious we emit the generic template with TODOs rather than guess and hand
 * someone a config that fails on their first `add`.
 *
 * Each preset's `config` is emitted verbatim (comments included) so the file
 * a user opens explains itself.
 */

import path from 'node:path';

const readPkg = (fs, file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const deps = (pkg) => ({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) });

/**
 * Identify the project shape. Returns a key into PRESETS.
 */
export function detectPreset(root, fs) {
  const has = (...p) => fs.existsSync(path.join(root, ...p));

  const pyManifest = ['backend/requirements.txt', 'requirements.txt', 'pyproject.toml']
    .find((f) => has(f));
  const webDir = ['frontend', 'client', 'web', 'ui'].find((d) => has(d, 'package.json'));
  const rootPkg = readPkg(fs, path.join(root, 'package.json'));
  const webPkg = webDir ? readPkg(fs, path.join(root, webDir, 'package.json')) : null;

  // Python API that also serves a built SPA — one process, one port.
  if (pyManifest && webDir) return 'python-spa';
  if (pyManifest && !webDir) {
    if (has('manage.py')) return 'django';
    return 'python';
  }

  const d = deps(webPkg || rootPkg);
  if (d.next) return 'nextjs';
  if (d.vite) return 'vite';
  if (d['react-scripts']) return 'cra';
  if (rootPkg?.scripts?.start || rootPkg?.scripts?.dev) return 'node';
  return 'generic';
}

const PY_POOL = `    {
      "id": "py",
      "manifests": ["MANIFEST"],
      // The pool directory is \${POOL}; \${BIN} is Scripts on Windows, bin elsewhere.
      // \${MANIFEST} points at the file inside the worktree, so "-r" includes resolve.
      "install": [
        "python -m venv \\"\${POOL}/venv\\"",
        "\\"\${POOL}/venv/\${BIN}/python\\" -m pip install --disable-pip-version-check -r \\"\${MANIFEST}\\""
      ]
    }`;

const NODE_POOL = (dir) => `    {
      "id": "node",
      "manifests": ["${dir}package-lock.json", "${dir}package.json"],
      "install": "npm ci --prefer-offline --no-audit --no-fund",
      // Linked into the worktree, so the build resolves modules normally.
      // On Windows this is a junction — no administrator rights needed.
      "link": { "${dir}node_modules": "\${POOL}/node_modules" }
    }`;

export const PRESETS = {
  'python-spa': {
    label: 'Python API serving a built JavaScript frontend',
    todo: [
      'check "services[0].run" matches how you start your API',
      'check the frontend build command and its output directory',
      'set "envFiles" if your app needs a .env copied from your clone',
    ],
    config: `{
  // branchdeck preview configuration — https://github.com/mhumphries-wlu/BranchDeck
  //
  // Placeholders: \${PORT} \${PORT:id} \${WORKTREE} \${REPO} \${BRANCH} \${SLOT}
  //               \${POOL} \${POOL:id} \${MANIFEST} \${BIN}
  "name": "app",

  // Dependency pools are SHARED across branches whose manifests are identical,
  // and automatically kept separate when a branch changes its dependencies.
  "pools": [
${PY_POOL.replace('MANIFEST', 'backend/requirements.txt')},
${NODE_POOL('frontend/')}
  ],

  // Build steps re-run only when files under "when" changed between commits.
  "build": [
    {
      "name": "building frontend",
      "run": "npm run build",
      "cwd": "frontend",
      "when": ["frontend"],
      "output": "frontend/build"
    }
  ],

  // Injects a small watcher into the built HTML so any open tab reloads
  // itself after this preview is rebuilt. Delete this block to turn it off.
  "reload": {
    "injectInto": ["frontend/build/index.html"],
    "intervalSeconds": 3
  },

  // One process per service; each gets a free port. \${PORT} and the PORT env
  // var are both set. The first service (or one with "open": true) is what
  // \`branchdeck open\` opens.
  "services": [
    {
      "id": "app",
      "label": "Backend",
      "run": "\\"\${POOL:py}/venv/\${BIN}/python\\" -m uvicorn backend.main:app --host 127.0.0.1 --port \${PORT}",
      "env": { "PYTHONPATH": "\${WORKTREE}/backend" },
      "health": { "path": "/api/health" }
    }
  ],

  // Copied from your clone (never committed), then a managed block appended.
  "envFiles": [
    {
      "path": "backend/.env",
      "copyFrom": ["backend/.env", ".env"],
      // Many frameworks reject requests from an unknown origin; add this
      // preview's own origin to whatever allowlist yours uses.
      "appendToCsv": {
        "FRONTEND_URLS": ["http://localhost:\${PORT:app}", "http://127.0.0.1:\${PORT:app}"]
      }
    }
  ]
}`,
  },

  django: {
    label: 'Django project',
    todo: ['confirm the WSGI/ASGI entry point and any migration step you need'],
    config: `{
  "name": "django-app",
  "pools": [
${PY_POOL.replace('MANIFEST', 'requirements.txt')}
  ],
  "build": [
    {
      "name": "migrating",
      "run": "\\"\${POOL:py}/venv/\${BIN}/python\\" manage.py migrate --noinput",
      "when": ["*/migrations"]
    }
  ],
  "services": [
    {
      "id": "web",
      "run": "\\"\${POOL:py}/venv/\${BIN}/python\\" manage.py runserver 127.0.0.1:\${PORT}",
      "health": { "path": "/" }
    }
  ]
}`,
  },

  python: {
    label: 'Python service',
    todo: ['set "services[0].run" to your actual start command'],
    config: `{
  "name": "python-app",
  "pools": [
${PY_POOL.replace('MANIFEST', 'requirements.txt')}
  ],
  "services": [
    {
      "id": "app",
      // TODO: your start command; it must bind \${PORT}
      "run": "\\"\${POOL:py}/venv/\${BIN}/python\\" -m uvicorn main:app --host 127.0.0.1 --port \${PORT}"
    }
  ]
}`,
  },

  nextjs: {
    label: 'Next.js application',
    todo: ['previews run `next build` then `next start` (production mode)'],
    config: `{
  "name": "next-app",
  "pools": [
${NODE_POOL('')}
  ],
  "build": [
    { "name": "next build", "run": "npm run build", "when": ["."], "output": ".next" }
  ],
  "services": [
    { "id": "web", "run": "npx next start --port \${PORT}" }
  ]
}`,
  },

  vite: {
    label: 'Vite application',
    todo: ['previews serve the production build via `vite preview`'],
    config: `{
  "name": "vite-app",
  "pools": [
${NODE_POOL('')}
  ],
  "build": [
    { "name": "vite build", "run": "npm run build", "when": ["."], "output": "dist" }
  ],
  "services": [
    { "id": "web", "run": "npx vite preview --port \${PORT} --strictPort" }
  ]
}`,
  },

  cra: {
    label: 'Create React App',
    todo: ['previews serve the production build with `npx serve`'],
    config: `{
  "name": "cra-app",
  "pools": [
${NODE_POOL('')}
  ],
  "build": [
    { "name": "react build", "run": "npm run build", "when": ["."], "output": "build" }
  ],
  "services": [
    { "id": "web", "run": "npx --yes serve -s build -l \${PORT}" }
  ]
}`,
  },

  node: {
    label: 'Node application',
    todo: ['set "services[0].run" — it must bind ${PORT} (also exported as PORT)'],
    config: `{
  "name": "node-app",
  "pools": [
${NODE_POOL('')}
  ],
  "services": [
    { "id": "app", "run": "npm start" }
  ]
}`,
  },

  generic: {
    label: 'unrecognised project — template written with TODOs',
    todo: [
      'add a "pools" entry per dependency manager you use (optional)',
      'set "services[0].run" to a command that binds ${PORT}',
      'add "build" steps if your app needs compiling before it runs',
    ],
    config: `{
  // branchdeck preview configuration — https://github.com/mhumphries-wlu/BranchDeck
  //
  // Placeholders: \${PORT} \${PORT:id} \${WORKTREE} \${REPO} \${BRANCH} \${SLOT}
  //               \${POOL} \${POOL:id} \${MANIFEST} \${BIN}
  "name": "app",

  // OPTIONAL. Shared, content-addressed dependency installs. A pool is keyed
  // by the hash of its "manifests", so branches with identical dependencies
  // reuse one install and a branch that changes them gets its own.
  "pools": [
    // {
    //   "id": "node",
    //   "manifests": ["package-lock.json", "package.json"],
    //   "install": "npm ci",
    //   "link": { "node_modules": "\${POOL}/node_modules" }
    // }
  ],

  // OPTIONAL. Re-run only when files under "when" changed between commits.
  "build": [
    // { "name": "build", "run": "npm run build", "when": ["src"], "output": "dist" }
  ],

  // REQUIRED. One process per service, each on its own free port.
  "services": [
    {
      "id": "app",
      "run": "TODO: your start command, binding \${PORT}",
      // Default readiness check is a TCP connect. For a stricter check:
      // "health": { "path": "/healthz" }
      "open": true
    }
  ],

  // OPTIONAL. Copy an untracked env file from your clone into each preview
  // and append preview-specific values.
  "envFiles": [
    // { "path": ".env", "copyFrom": [".env"], "set": { "PREVIEW_BRANCH": "\${BRANCH}" } }
  ]
}`,
  },
};
