#!/usr/bin/env node
/**
 * Verify commercial release readiness evidence.
 *
 * The default "candidate" target confirms that local release-candidate evidence is
 * present while keeping unresolved commercial blockers explicit. The
 * "commercial-ready" target is intentionally stricter and fails until every
 * required manual approval is recorded as approved.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_APPROVAL_IDS = [
  'public-brand',
  'license-posture',
  'provider-model-matrix',
  'provider-pricing-policy',
  'signing-update-channel',
  'privacy-support',
  'distribution-channel',
  'manual-packaged-app-acceptance',
];

const VALID_TARGETS = new Set(['candidate', 'commercial-ready']);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function resolveRepoPath(repoRoot, relativePath) {
  return path.resolve(repoRoot, relativePath);
}

function validateCommercialReadiness(options) {
  const {
    manifest,
    desktopPackageJson,
    repoRoot,
    target = 'candidate',
    fileExists = fs.existsSync,
    readText = (filePath) => fs.readFileSync(filePath, 'utf-8'),
  } = options;

  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown readiness target: ${target}`);
  }

  const issues = [];
  const warnings = [];
  const blockers = [];

  const addIssue = (message) => issues.push(message);
  const addWarning = (message) => warnings.push(message);

  if (!manifest || typeof manifest !== 'object') {
    return {
      verified: false,
      target,
      status: 'invalid',
      issues: ['Manifest must be a JSON object.'],
      warnings,
      blockers,
    };
  }

  if (!manifest.version) {
    addIssue('Manifest version is required.');
  }

  const product = manifest.product ?? {};
  if (product.packageName !== desktopPackageJson.name) {
    addIssue(`Product packageName ${product.packageName ?? '<missing>'} does not match package.json name ${desktopPackageJson.name}.`);
  }
  if (product.packageVersion !== desktopPackageJson.version) {
    addIssue(`Product packageVersion ${product.packageVersion ?? '<missing>'} does not match package.json version ${desktopPackageJson.version}.`);
  }
  if (product.productName !== desktopPackageJson.build?.productName) {
    addIssue(`Product productName ${product.productName ?? '<missing>'} does not match electron-builder productName ${desktopPackageJson.build?.productName}.`);
  }
  if (product.appId !== desktopPackageJson.build?.appId) {
    addIssue(`Product appId ${product.appId ?? '<missing>'} does not match electron-builder appId ${desktopPackageJson.build?.appId}.`);
  }
  if (product.license !== desktopPackageJson.license) {
    addIssue(`Product license ${product.license ?? '<missing>'} does not match package.json license ${desktopPackageJson.license}.`);
  }

  validateCandidateEvidence(manifest, repoRoot, target, fileExists, readText, addIssue, addWarning);

  const approvals = Array.isArray(manifest.manualApprovals) ? manifest.manualApprovals : [];
  const approvalsById = new Map(approvals.map((approval) => [approval.id, approval]));

  for (const id of REQUIRED_APPROVAL_IDS) {
    const approval = approvalsById.get(id);
    if (!approval) {
      addIssue(`Manual approval ${id} is missing from the manifest.`);
      continue;
    }
    if (!approval.status) {
      addIssue(`Manual approval ${id} is missing a status.`);
      continue;
    }
    if (approval.requiredFor !== 'commercial-ready') {
      addIssue(`Manual approval ${id} must declare requiredFor: commercial-ready.`);
    }
    if (approval.status !== 'approved') {
      blockers.push({
        id,
        label: approval.label ?? id,
        status: approval.status,
        owner: approval.owner ?? 'unassigned',
      });
    }
  }

  const commercialStatus = manifest.commercialReadiness?.status ?? 'missing';
  if (target === 'commercial-ready') {
    if (commercialStatus !== 'commercial-ready') {
      addIssue(`Commercial readiness status must be commercial-ready for the commercial-ready target; found ${commercialStatus}.`);
    }
    for (const blocker of blockers) {
      addIssue(`Commercial-ready target still has unresolved approval ${blocker.id} (${blocker.status}).`);
    }
  } else if (commercialStatus === 'commercial-ready' && blockers.length > 0) {
    addIssue('Manifest claims commercial-ready while manual blockers remain unresolved.');
  }

  return {
    verified: issues.length === 0,
    target,
    status: commercialStatus,
    issues,
    warnings,
    blockers,
  };
}

function validateCandidateEvidence(manifest, repoRoot, target, fileExists, readText, addIssue, addWarning) {
  const evidence = manifest.candidateEvidence ?? {};

  const providerSupport = evidence.providerModelSupport ?? {};
  if (providerSupport.status !== 'documented') {
    addIssue('Provider/model support evidence must have status: documented.');
  }
  validateDocumentEvidence({
    label: 'provider/model support document',
    repoRoot,
    relativePath: providerSupport.path,
    mustContain: [
      `Version: ${providerSupport.version ?? manifest.version}`,
      '## Cost Display Policy',
    ],
    fileExists,
    readText,
    addIssue,
  });

  const tokenCost = evidence.tokenCostDisplayPolicy ?? {};
  if (tokenCost.monetaryEstimates !== 'disabled') {
    addIssue('Commercial v1 must keep monetary cost estimates disabled until pricing reconciliation is approved.');
  }
  if (tokenCost.tokenCounts !== 'enabled') {
    addIssue('Commercial v1 must keep token count display enabled.');
  }

  const memoryEfficiency = evidence.memoryTokenEfficiency ?? {};
  if (memoryEfficiency.status !== 'passed') {
    addIssue('Memory/token efficiency evidence must have status: passed.');
  }
  if (memoryEfficiency.runtimeContextSelection !== 'trusted-deduped-ranked') {
    addIssue('Memory/token efficiency evidence must record trusted-deduped-ranked runtime context selection.');
  }
  if (
    typeof memoryEfficiency.maxRuntimeContextChars !== 'number' ||
    memoryEfficiency.maxRuntimeContextChars <= 0 ||
    memoryEfficiency.maxRuntimeContextChars > 1800
  ) {
    addIssue('Memory/token efficiency evidence must record a max runtime context budget no larger than 1800 chars.');
  }
  if (!Array.isArray(memoryEfficiency.checks) || memoryEfficiency.checks.length === 0) {
    addIssue('Memory/token efficiency evidence must list verification checks.');
  }

  const privacySupport = evidence.privacySupport ?? {};
  if (privacySupport.status !== 'documented') {
    addIssue('Privacy/support evidence must have status: documented.');
  }
  if (privacySupport.telemetryDefault !== 'disabled') {
    addIssue('Commercial v1 privacy/support evidence must record disabled-by-default telemetry.');
  }
  if (privacySupport.automaticCrashUpload !== 'disabled') {
    addIssue('Commercial v1 privacy/support evidence must record disabled automatic crash upload.');
  }
  if (privacySupport.supportLogSharing !== 'user-reviewed-redacted') {
    addIssue('Commercial v1 privacy/support evidence must require user-reviewed redacted support log sharing.');
  }
  validateDocumentEvidence({
    label: 'privacy/support policy document',
    repoRoot,
    relativePath: privacySupport.path,
    mustContain: [
      `Version: ${privacySupport.version ?? manifest.version}`,
      'Default telemetry posture: disabled',
      'Crash diagnostics must not be uploaded automatically',
      'review or redact logs before sharing',
    ],
    fileExists,
    readText,
    addIssue,
  });

  const windowsPackage = evidence.windowsPackage ?? {};
  if (windowsPackage.status !== 'passed') {
    addIssue('Windows package evidence must have status: passed for the current first-platform candidate.');
  }
  for (const field of ['artifactSmoke', 'launchSmoke']) {
    if (windowsPackage[field] !== 'passed') {
      addIssue(`Windows package ${field} must be passed.`);
    }
  }
  const requiredArtifacts = Array.isArray(windowsPackage.requiredArtifacts)
    ? windowsPackage.requiredArtifacts
    : [];
  if (requiredArtifacts.length === 0) {
    addIssue('Windows package evidence must list required artifact paths.');
  }
  for (const artifact of requiredArtifacts) {
    const artifactPath = resolveRepoPath(repoRoot, artifact);
    if (!fileExists(artifactPath)) {
      addIssue(`Required Windows package artifact is missing: ${artifact}`);
    }
  }

  validateDocumentEvidence({
    label: 'verification baseline',
    repoRoot,
    relativePath: evidence.verificationBaseline?.path,
    mustContain: ['## Passing Checks'],
    fileExists,
    readText,
    addIssue,
  });
  validateDocumentEvidence({
    label: 'release readiness summary',
    repoRoot,
    relativePath: evidence.releaseReadinessSummary?.path,
    mustContain: target === 'commercial-ready' ? ['Release Readiness Summary'] : ['not commercial ready'],
    fileExists,
    readText,
    addIssue,
  });

  const platformScope = evidence.platformScope ?? {};
  if (!Array.isArray(platformScope.verifiedPlatforms) || platformScope.verifiedPlatforms.length === 0) {
    addIssue('Platform scope must list at least one verified platform.');
  }
  if (!platformScope.verifiedPlatforms?.includes('windows-x64')) {
    addWarning('Current first-platform candidate does not list windows-x64 as verified.');
  }
}

function validateDocumentEvidence({
  label,
  repoRoot,
  relativePath,
  mustContain,
  fileExists,
  readText,
  addIssue,
}) {
  if (!relativePath) {
    addIssue(`${label} path is required.`);
    return;
  }

  const filePath = resolveRepoPath(repoRoot, relativePath);
  if (!fileExists(filePath)) {
    addIssue(`${label} is missing: ${relativePath}`);
    return;
  }

  const text = readText(filePath);
  for (const expected of mustContain) {
    if (!text.includes(expected)) {
      addIssue(`${label} does not contain required text: ${expected}`);
    }
  }
}

function printResult(result) {
  console.log(`Commercial readiness target: ${result.target}`);
  console.log(`Commercial readiness status: ${result.status}`);

  if (result.blockers.length > 0) {
    console.log('\nUnresolved manual blockers:');
    for (const blocker of result.blockers) {
      console.log(`- ${blocker.id}: ${blocker.status} (${blocker.owner})`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (result.issues.length > 0) {
    console.error('\nReadiness issues:');
    for (const issue of result.issues) {
      console.error(`- ${issue}`);
    }
  }

  console.log(result.verified ? '\nREADINESS CHECK PASSED' : '\nREADINESS CHECK FAILED');
}

function parseArgs(argv) {
  let manifestPath;
  let target = 'candidate';

  for (const arg of argv) {
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (!manifestPath) {
      manifestPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { manifestPath, target };
}

function main() {
  const desktopDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(desktopDir, '..', '..');
  const { manifestPath, target } = parseArgs(process.argv.slice(2));
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath ?? 'guides/commercial-readiness.manifest.json');
  const manifest = loadJson(resolvedManifestPath);
  const desktopPackageJson = loadJson(path.join(desktopDir, 'package.json'));
  const result = validateCommercialReadiness({
    manifest,
    desktopPackageJson,
    repoRoot,
    target,
  });

  printResult(result);
  process.exit(result.verified ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_APPROVAL_IDS,
  validateCommercialReadiness,
  validateCandidateEvidence,
  parseArgs,
};
