'use strict';

const fs = require('fs');

const DAY_MS = 86400000;
const BASE_BRANCH = 'main';      // branch that PRs must have been merged into
const BRANCH_PREFIX = 'feat/';   // only these branches are ever considered

// One set of rules, used by BOTH discovery and cleanup so they cannot drift apart.
async function evaluateBranch({ github, core, owner, repo, branch, retentionDays }) {
  const reasons = [];

  // 1. Age: based on the last commit date.
  let lastCommit = null;
  try {
    const { data } = await github.rest.repos.getCommit({
      owner, repo, ref: branch.commit.sha
    });
    lastCommit = data.commit.committer?.date || data.commit.author?.date || null;
  } catch (error) {
    core.warning(`Commit lookup failed for ${branch.name}: ${error.message}`);
  }

  const timestamp = lastCommit ? Date.parse(lastCommit) : NaN;
  const ageDays = Number.isFinite(timestamp)
    ? Math.floor((Date.now() - timestamp) / DAY_MS)
    : null;

  if (ageDays === null) {
    reasons.push('Last commit date unavailable');
  } else if (ageDays < retentionDays) {
    reasons.push(`Last commit is ${ageDays} day(s) old; minimum is ${retentionDays}`);
  }

  // 2. Protected branches are never touched.
  if (branch.protected) reasons.push('Branch is protected');

  // 3. Pull requests.
  const prs = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'all', head: `${owner}:${branch.name}`, per_page: 100
  });
  const openPRs = prs.filter(pr => pr.state === 'open');
  const mergedPRs = prs.filter(pr => pr.merged_at && pr.base.ref === BASE_BRANCH);

  if (openPRs.length) reasons.push('Open pull request exists');

  // A merged PR whose head SHA equals the branch tip means nothing was pushed
  // after the merge. Unlike "ahead_by", this also works for squash merges.
  let comparisonStatus = 'NOT_CHECKED';
  if (!mergedPRs.length) {
    reasons.push(`No merged pull request into ${BASE_BRANCH} found`);
  } else if (mergedPRs.some(pr => pr.head.sha === branch.commit.sha)) {
    comparisonStatus = 'PASSED';
  } else {
    comparisonStatus = 'REVIEW_REQUIRED';
    reasons.push('Branch has commits added after its pull request was merged');
  }

  return {
    branch: branch.name,
    sha: branch.commit.sha,
    lastCommit: lastCommit || 'Unknown',
    ageDays: ageDays ?? 'Unknown',
    protected: Boolean(branch.protected),
    mergedIntoMain: mergedPRs.length > 0,
    openPRCount: openPRs.length,
    comparisonStatus,
    basicChecks: reasons.length ? 'EXCLUDED' : 'PASSED',
    deletionStatus: 'NOT_ATTEMPTED',
    reasons: reasons.join('; ') || 'All checks passed'
  };
}

// PHASE 1
async function discover({ github, context, core }) {
  const { owner, repo } = context.repo;
  const retentionDays = Number(process.env.RETENTION_DAYS ?? 30);
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`Invalid retention_days: ${process.env.RETENTION_DAYS}`);
  }

  const branches = await github.paginate(github.rest.repos.listBranches, {
    owner, repo, per_page: 100
  });

  const report = [];
  for (const branch of branches.filter(b => b.name.startsWith(BRANCH_PREFIX))) {
    report.push(await evaluateBranch({ github, core, owner, repo, branch, retentionDays }));
  }

  const eligible = report.filter(r => r.basicChecks === 'PASSED');
  const payload = {
    generatedAt: new Date().toISOString(),
    owner,
    repo,
    baseBranch: BASE_BRANCH,
    retentionDays,
    totalBranches: report.length,
    basicChecksPassedCount: eligible.length,
    excludedCount: report.length - eligible.length,
    branches: report
  };

  fs.writeFileSync('branch-report-data.json', JSON.stringify(payload, null, 2));
  core.setOutput('candidate_count', String(eligible.length));

  // Shown on the run page, so approvers see the list without downloading anything.
  core.summary
    .addHeading('Phase 1 - Branch discovery', 2)
    .addRaw(
      `Scanned ${report.length} branch(es). Eligible for cleanup: ${eligible.length} ` +
      `(last commit at least ${retentionDays} days old). Nothing has been deleted.`,
      true
    );
  if (eligible.length) {
    core.summary.addTable([
      [{ data: 'Branch', header: true }, { data: 'Last commit', header: true }, { data: 'Age (days)', header: true }],
      ...eligible.map(r => [r.branch, r.lastCommit, String(r.ageDays)])
    ]);
  }
  await core.summary.write();
}

// PHASE 2 - runs only after the environment approval.
async function cleanup({ github, context, core }) {
  const { owner, repo } = context.repo;
  const payload = JSON.parse(
    fs.readFileSync('cleanup-input/branch-report-data.json', 'utf8')
  );
  const results = [];

  for (const candidate of payload.branches) {
    if (candidate.basicChecks !== 'PASSED') {
      results.push({
        branch: candidate.branch,
        status: 'SKIPPED',
        reason: 'Not eligible at discovery'
      });
      continue;
    }

    try {
      const { data: current } = await github.rest.repos.getBranch({
        owner, repo, branch: candidate.branch
      });

      if (current.commit.sha !== candidate.sha) {
        throw new Error('Branch changed after discovery');
      }

      // Re-run every rule right before deleting (approval may be days later).
      const check = await evaluateBranch({
        github, core, owner, repo,
        branch: { name: candidate.branch, protected: current.protected, commit: { sha: current.commit.sha } },
        retentionDays: payload.retentionDays
      });
      if (check.basicChecks !== 'PASSED') {
        throw new Error(`No longer eligible: ${check.reasons}`);
      }

      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${candidate.branch}` });

      results.push({
        branch: candidate.branch,
        status: 'DELETED',
        reason: 'Re-validated and deleted after approval'
      });
    } catch (error) {
      results.push({
        branch: candidate.branch,
        status: 'SKIPPED_OR_FAILED',
        reason: error.message
      });
      core.warning(`Cleanup not completed for ${candidate.branch}: ${error.message}`);
    }
  }

  fs.writeFileSync(
    'cleanup-results.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)
  );
  core.info(`Cleanup results recorded: ${results.length}`);
}

// PHASE 3 - ask GitHub whether each "DELETED" branch is really gone.
async function verifyDeletions({ github, context, core }) {
  const file = 'cleanup-input/cleanup-results.json';
  if (!fs.existsSync(file)) {
    core.info('No cleanup results found (approval rejected or cleanup skipped).');
    return;
  }

  const { owner, repo } = context.repo;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const result of data.results) {
    if (result.status !== 'DELETED') continue;
    try {
      await github.rest.repos.getBranch({ owner, repo, branch: result.branch });
      result.status = 'SKIPPED_OR_FAILED';
      result.reason = 'Deletion was reported but the branch still exists';
    } catch (error) {
      result.reason = error.status === 404
        ? 'Deleted and confirmed gone'
        : `Deleted; confirmation inconclusive (${error.message})`;
    }
  }

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

module.exports = { discover, cleanup, verifyDeletions };