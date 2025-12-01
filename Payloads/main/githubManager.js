/**
 * githubManager.js
 * Handles GitHub connectivity, push, and pull operations.
 */
const path = require('path');
const AdmZip = require('adm-zip');
const log = require('../logger');
const githubStore = require('./githubStore');

const API_BASE = 'https://api.github.com';
const POSIX = path.posix;

const withAuthHeaders = (pat) => ({
  Authorization: `Bearer ${pat}`,
  'User-Agent': 'Chromo/Electron',
  Accept: 'application/vnd.github+json'
});

// Confirms the PAT has access to the requested repository.
async function verifyRepository(config) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}`;
  const response = await fetch(url, { headers: withAuthHeaders(config.pat) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to verify repository: ${response.status} ${body}`);
  }
}

// Returns the SHA of the configured file if it already exists.
async function getExistingFileSha(config) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/contents/${config.defaultPath}?ref=${config.branch}`;
  const response = await fetch(url, { headers: withAuthHeaders(config.pat) });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch existing file info: ${response.status} ${body}`);
  }
  const data = await response.json();
  return data.sha;
}

// Pushes inline text content to the configured repository path.
async function pushContent({ commitMessage, textContent, zipBytes, zipFileName }) {
  const config = await githubStore.loadConfig();
  if (!config.pat || !config.owner || !config.repository || !config.defaultPath) {
    throw new Error('Missing GitHub configuration. Please fill Owner/Repo/Path.');
  }

  const hasZip = !!zipBytes && (zipBytes.length || zipBytes.byteLength);

  if (hasZip) {
    const buffer = normalizeToBuffer(zipBytes);
    if (!buffer || !buffer.length) {
      throw new Error('Zip archive is empty.');
    }
    log.info('[GitHub] Zip push requested', {
      repo: `${config.owner}/${config.repository}`,
      branch: config.branch,
      fileName: zipFileName,
      zipKB: Number(buffer.length / 1024).toFixed(2)
    });
    return pushZipArchive({
      config,
      commitMessage,
      zipBuffer: buffer,
      zipFileName
    });
  }

  if (!textContent || !textContent.length) {
    throw new Error('Enter some text or select a zip archive to push.');
  }
  const contentBuffer = Buffer.from(textContent, 'utf8');
  log.info('[GitHub] Text push requested', {
    repo: `${config.owner}/${config.repository}`,
    branch: config.branch,
    bytes: contentBuffer.length
  });
  const sha = await getExistingFileSha(config);

  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/contents/${config.defaultPath}`;
  const body = {
    message: commitMessage || config.defaultCommitMessage,
    content: contentBuffer.toString('base64'),
    branch: config.branch,
    sha: sha || undefined
  };
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      ...withAuthHeaders(config.pat),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to push file: ${response.status} ${text}`);
  }
  const result = await response.json();
  return {
    ...result,
    bytes: contentBuffer.length,
    files: 1
  };
}

// Downloads the configured file contents so the renderer can show it.
async function pullContent() {
  const config = await githubStore.loadConfig();
  if (!config.pat || !config.owner || !config.repository || !config.defaultPath) {
    throw new Error('Missing GitHub configuration or default path.');
  }
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/contents/${config.defaultPath}?ref=${config.branch}`;
  const response = await fetch(url, { headers: withAuthHeaders(config.pat) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to pull file: ${response.status} ${text}`);
  }
  const data = await response.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf8')
  };
}

// Validates and persists the Git connection settings.
async function saveConfig(config) {
  await verifyRepository(config);
  const normalized = {
    ...config,
    branch: config.branch || 'main',
    defaultCommitMessage: config.defaultCommitMessage || 'chore: push from Chromo'
  };
  return githubStore.saveConfig(normalized);
}

// Clears stored GitHub credentials/PAT.
async function signOut() {
  await githubStore.clearConfig();
}

module.exports = {
  saveConfig,
  loadConfig: githubStore.loadConfig,
  signOut,
  pushContent,
  pullContent,
  pushJson   
};


// Helper: create/update a JSON file at a repo path.
async function pushJson({ owner, repo, branch = 'main', filePath, token, commitMessage, json }) {
  if (!owner || !repo || !filePath) {
    throw new Error('pushJson: owner, repo, and filePath are required');
  }
  if (!token) {
    throw new Error('pushJson: token is required');
  }

  // 1) If the file exists, get its SHA (updates require sha)
  let sha = null;
  {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: withAuthHeaders(token) });
    if (res.status === 200) {
      const j = await res.json();
      sha = j.sha;
    } else if (res.status !== 404) {
      const text = await res.text();
      throw new Error(`GitHub GET contents failed: ${res.status} ${text}`);
    }
  }

  // 2) Prepare content
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = {
    message: commitMessage || `chore(payload): add ${filePath}`,
    content,
    branch,
    ...(sha ? { sha } : {})
  };

  // 3) PUT create/update
  {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        ...withAuthHeaders(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub PUT contents failed: ${res.status} ${text}`);
    }
    return res.json();
  }
}

function normalizeToBuffer(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return input;

  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }

  // ipcRenderer may serialize Buffers as { type: 'Buffer', data: [] }
  if (Array.isArray(input)) {
    return Buffer.from(input);
  }
  if (input && input.type === 'Buffer' && Array.isArray(input.data)) {
    return Buffer.from(input.data);
  }

  return null;
}

const cleanBasePath = (input = '') => {
  if (!input) return '';
  const normalized = POSIX.normalize(String(input).trim().replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '/') {
    return '';
  }
  return normalized.replace(/^\/+/, '').replace(/\/+$/, '');
};

const deriveZipPrefix = (input = '') => {
  if (!input) return '';
  const normalized = cleanBasePath(input);
  if (!normalized) return '';

  const originalEndsWithSlash = /[\\/]$/.test(input.trim());
  if (originalEndsWithSlash) {
    return normalized;
  }

  if (!normalized.includes('/')) {
    return normalized.includes('.') ? '' : normalized;
  }

  const lastSlash = normalized.lastIndexOf('/');
  const tail = normalized.slice(lastSlash + 1);
  if (tail.includes('.')) {
    return normalized.slice(0, lastSlash);
  }
  return normalized;
};

const sanitizeEntryPath = (entryName = '') => {
  if (!entryName) return null;
  const normalized = POSIX.normalize(entryName.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.endsWith('/')) {
    return null;
  }
  if (normalized.startsWith('..')) {
    return null;
  }
  const trimmed = normalized.replace(/^\/+/, '');
  if (trimmed.toLowerCase().startsWith('__macosx/')) {
    return null;
  }
  return trimmed;
};

async function pushZipArchive({ config, commitMessage, zipBuffer, zipFileName }) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (!entries.length) {
    throw new Error('Zip archive contains no files to push.');
  }

  const repoPrefix = deriveZipPrefix(config.defaultPath);
  const files = [];
  entries.forEach((entry) => {
    const relative = sanitizeEntryPath(entry.entryName);
    if (!relative) {
      return;
    }
    const repoPath = repoPrefix ? `${repoPrefix}/${relative}` : relative;
    files.push({
      path: repoPath,
      buffer: entry.getData()
    });
  });

  if (!files.length) {
    throw new Error('Zip archive did not contain any publishable files.');
  }
  log.info('[GitHub] Zip archive parsed', {
    repo: `${config.owner}/${config.repository}`,
    branch: config.branch,
    repoPrefix,
    files: files.length,
    zipKB: Number(zipBuffer.length / 1024).toFixed(2)
  });

  const ref = await getBranchRef(config);
  const baseCommitSha = ref?.object?.sha;
  if (!baseCommitSha) {
    throw new Error('Unable to resolve branch reference.');
  }

  const baseCommit = await getCommit(config, baseCommitSha);
  const blobs = [];
  for (const file of files) {
    const blob = await createBlob(config, file.buffer);
    blobs.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha
    });
  }

  const tree = await createTreeWithChunks(config, baseCommit.tree.sha, blobs);
  const message =
    commitMessage?.trim() ||
    config.defaultCommitMessage ||
    `chore: push ${zipFileName || 'archive'}`;
  const commit = await createCommit(config, message, tree.sha, baseCommitSha);
  await updateRef(config, commit.sha);
  log.info('[GitHub] Zip push committed', {
    repo: `${config.owner}/${config.repository}`,
    files: files.length,
    commit: commit.sha
  });
  return {
    files: files.length,
    commit,
    bytes: zipBuffer.length
  };
}

async function getBranchRef(config) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/git/refs/heads/${encodeURIComponent(
    config.branch
  )}`;
  return requestJson(url, {
    headers: withAuthHeaders(config.pat)
  });
}

async function getCommit(config, sha) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/git/commits/${sha}`;
  return requestJson(url, {
    headers: withAuthHeaders(config.pat)
  });
}

async function createBlob(config, buffer) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/git/blobs`;
  return requestJson(url, {
    method: 'POST',
    headers: {
      ...withAuthHeaders(config.pat),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: buffer.toString('base64'),
      encoding: 'base64'
    })
  });
}

async function createTree(config, baseTreeSha, entries) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/git/trees`;
  return requestJson(url, {
    method: 'POST',
    headers: {
      ...withAuthHeaders(config.pat),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: entries
    })
  });
}

async function createTreeWithChunks(config, baseTreeSha, entries, chunkSize = 900) {
  if (!entries.length) {
    return { sha: baseTreeSha };
  }

  let currentTree = { sha: baseTreeSha };
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    currentTree = await createTree(config, currentTree.sha, chunk);
    log.info('[GitHub] Tree chunk committed', {
      repo: `${config.owner}/${config.repository}`,
      chunkSize: chunk.length,
      processed: Math.min(i + chunk.length, entries.length),
      total: entries.length
    });
  }
  return currentTree;
}

async function createCommit(config, message, treeSha, parentSha) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/git/commits`;
  return requestJson(url, {
    method: 'POST',
    headers: {
      ...withAuthHeaders(config.pat),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha]
    })
  });
}

async function updateRef(config, sha) {
  const url = `${API_BASE}/repos/${config.owner}/${config.repository}/git/refs/heads/${encodeURIComponent(
    config.branch
  )}`;
  return requestJson(url, {
    method: 'PATCH',
    headers: {
      ...withAuthHeaders(config.pat),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sha })
  });
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text}`);
  }
  return response.json();
}
