import fetch from 'node-fetch';
import { parseISO, formatISO, subDays } from 'date-fns';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import fs from 'fs';

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG_NAME = process.env.ORG_NAME;
const INITIAL_SINCE_DATE = '2000-01-01';

const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
};

// Initialize SQLite database
const dbPath = './db/github_stats.db';
if (!fs.existsSync(dbPath)) {
  console.log('Database file does not exist. A new one will be created by SQLite.');
}

const db = new sqlite3.Database(dbPath);
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

// Initialize database schema at module level
(async () => {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS github_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      day TEXT NOT NULL,
      additions INTEGER DEFAULT 0,
      deletions INTEGER DEFAULT 0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repo, day)
    )
  `);
  
  await dbRun(`
    CREATE TABLE IF NOT EXISTS commits_processed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      sha TEXT NOT NULL,
      commit_date TEXT NOT NULL,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repo, sha)
    )
  `);
})();

async function fetchOrgRepos() {
  const res = await fetch(`https://api.github.com/orgs/${ORG_NAME}/repos?per_page=100`, { headers });
  const repos = await res.json();
  return repos.map((repo) => repo.name);
}

async function fetchRepoCommits(repo, sinceDate) {
  const res = await fetch(`https://api.github.com/repos/${ORG_NAME}/${repo}/commits?since=${sinceDate}&per_page=100`, { headers });
  return await res.json();
}

async function fetchCommitStats(repo, sha) {
  const res = await fetch(`https://api.github.com/repos/${ORG_NAME}/${repo}/commits/${sha}`, { headers });
  const data = await res.json();
  return data.stats || { additions: 0, deletions: 0 };
}

async function getLatestCommitDate() {
  const result = await dbGet(`
    SELECT MAX(commit_date) as latest_date 
    FROM commits_processed
  `);
  return result?.latest_date;
}

async function isCommitProcessed(repo, sha) {
  const result = await dbGet(`
    SELECT COUNT(*) as count 
    FROM commits_processed 
    WHERE repo = ? AND sha = ?
  `, [repo, sha]);
  return result.count > 0;
}

async function markCommitProcessed(repo, sha, commitDate) {
  await dbRun(`
    INSERT OR IGNORE INTO commits_processed (repo, sha, commit_date) 
    VALUES (?, ?, ?)
  `, [repo, sha, commitDate]);
}

async function upsertStats(repo, day, additions, deletions) {
  await dbRun(`
    INSERT OR REPLACE INTO github_stats (repo, day, additions, deletions, last_updated)
    VALUES (?, ?, 
      COALESCE((SELECT additions FROM github_stats WHERE repo = ? AND day = ?), 0) + ?,
      COALESCE((SELECT deletions FROM github_stats WHERE repo = ? AND day = ?), 0) + ?,
      CURRENT_TIMESTAMP)
  `, [repo, day, repo, day, additions, repo, day, deletions]);
}

async function updateStatsForTimeRange(fromDate, toDate) {
  // Check if we have recent data (within last 24 hours) for this range
  const latestUpdate = await dbGet(`
    SELECT MAX(last_updated) as latest_update 
    FROM github_stats
    WHERE day >= ? AND day <= ?
  `, [fromDate, toDate]);
  
  if (latestUpdate?.latest_update) {
    const lastUpdate = new Date(latestUpdate.latest_update);
    const oneDayAgo = subDays(new Date(), 1);
    
    // Skip update if data is fresh (less than 24 hours old)
    if (lastUpdate > oneDayAgo) {
      console.log('Data is fresh, skipping update');
      return;
    }
  }
  
  // Get the latest commit date from our database
  const latestDate = await getLatestCommitDate();
  
  // Determine the optimal since date for fetching
  let sinceDate = INITIAL_SINCE_DATE;
  if (latestDate) {
    const latest = parseISO(latestDate);
    const safeDate = subDays(latest, 1);
    const safeDateStr = formatISO(safeDate, { representation: 'date' });
    
    // Use the earlier of the safe date or the requested from date
    sinceDate = fromDate && fromDate < safeDateStr ? fromDate : safeDateStr;
  } else if (fromDate) {
    // If no cached data but from date is specified, use from date
    sinceDate = fromDate;
  }
  
  console.log(`Fetching commits since: ${sinceDate}`);
  
  const repos = await fetchOrgRepos();
  
  for (const repo of repos) {
    console.log(`Processing repo: ${repo}`);
    const commits = await fetchRepoCommits(repo, sinceDate);
    
    for (const commit of commits) {
      if (!commit.commit || !commit.sha) continue;
      
      // Skip if already processed
      if (await isCommitProcessed(repo, commit.sha)) {
        continue;
      }
      
      const commitDate = commit.commit.author.date;
      const day = formatISO(parseISO(commitDate), { representation: 'date' });
      
      try {
        const stats = await fetchCommitStats(repo, commit.sha);
        await upsertStats(repo, day, stats.additions, stats.deletions);
        await markCommitProcessed(repo, commit.sha, commitDate);
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error processing commit ${commit.sha} for ${repo}:`, error);
      }
    }
  }
  
  console.log('Stats update completed');
}

export async function aggregateStats(fromTimeMs, toTimeMs) {
  // Convert timestamps to date strings
  const fromDate = formatISO(new Date(fromTimeMs), { representation: 'date' });
  const toDate = formatISO(new Date(toTimeMs), { representation: 'date' });

  // Always update data for the requested time range
  await updateStatsForTimeRange(fromDate, toDate);

  // Query data for the specified time range
  const query = `
    SELECT repo, day, additions, deletions, last_updated
    FROM github_stats 
    WHERE day >= ? AND day <= ?
    ORDER BY day DESC, repo ASC
  `;
  
  const results = await dbAll(query, [fromDate, toDate]);

  // Transform data for Grafana compatibility
  return results.map(row => ({
    repo: row.repo,
    day: row.day,
    additions: row.additions,
    deletions: row.deletions,
    total_changes: row.additions + row.deletions,
    timestamp: new Date(row.day).getTime() // Add timestamp for Grafana
  }));
}