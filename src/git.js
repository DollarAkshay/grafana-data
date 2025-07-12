import fetch from 'node-fetch';
import { parseISO, formatISO, startOfWeek, subDays } from 'date-fns';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG_NAME = process.env.ORG_NAME;
const INITIAL_SINCE_DATE = '2000-01-01';

const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
};

// Initialize SQLite database
const db = new sqlite3.Database('./github_stats.db');
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

// Initialize database schema
async function initializeDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS github_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      week TEXT NOT NULL,
      additions INTEGER DEFAULT 0,
      deletions INTEGER DEFAULT 0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repo, week)
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
}

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

async function upsertStats(repo, week, additions, deletions) {
  await dbRun(`
    INSERT OR REPLACE INTO github_stats (repo, week, additions, deletions, last_updated)
    VALUES (?, ?, 
      COALESCE((SELECT additions FROM github_stats WHERE repo = ? AND week = ?), 0) + ?,
      COALESCE((SELECT deletions FROM github_stats WHERE repo = ? AND week = ?), 0) + ?,
      CURRENT_TIMESTAMP)
  `, [repo, week, repo, week, additions, repo, week, deletions]);
}

async function updateStatsForTimeRange(fromDate, toDate) {
  await initializeDB();
  
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
      const week = formatISO(startOfWeek(parseISO(commitDate)), { representation: 'date' });
      
      try {
        const stats = await fetchCommitStats(repo, commit.sha);
        await upsertStats(repo, week, stats.additions, stats.deletions);
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

export async function aggregateStats(fromTime, toTime) {
  await initializeDB();
  
  // Convert timestamps to date strings if needed
  let fromDate = null;
  let toDate = null;
  
  if (fromTime) {
    // Handle both Unix timestamps (milliseconds) and ISO strings
    const from = typeof fromTime === 'string' ? parseISO(fromTime) : new Date(parseInt(fromTime));
    fromDate = formatISO(from, { representation: 'date' });
  }
  
  if (toTime) {
    // Handle both Unix timestamps (milliseconds) and ISO strings
    const to = typeof toTime === 'string' ? parseISO(toTime) : new Date(parseInt(toTime));
    toDate = formatISO(to, { representation: 'date' });
  }
  
  // Check if we need to update data
  const shouldUpdate = await needsDataUpdate(fromDate, toDate);
  
  if (shouldUpdate) {
    console.log('Updating data to ensure completeness...');
    await updateStatsForTimeRange(fromDate, toDate);
  }
  
  // Build query based on time range
  let query = `
    SELECT repo, week, additions, deletions, last_updated
    FROM github_stats 
  `;
  let params = [];
  
  if (fromDate && toDate) {
    query += ` WHERE week >= ? AND week <= ?`;
    params = [fromDate, toDate];
  } else if (fromDate) {
    query += ` WHERE week >= ?`;
    params = [fromDate];
  } else if (toDate) {
    query += ` WHERE week <= ?`;
    params = [toDate];
  }
  
  query += ` ORDER BY week DESC, repo ASC`;
  
  const results = await dbAll(query, params);
  
  // Transform data for Grafana compatibility
  return results.map(row => ({
    repo: row.repo,
    week: row.week,
    additions: row.additions,
    deletions: row.deletions,
    total_changes: row.additions + row.deletions,
    timestamp: new Date(row.week).getTime() // Add timestamp for Grafana
  }));
}

async function needsDataUpdate(fromDate, toDate) {
  // Always update if no data exists
  const dataCount = await dbGet('SELECT COUNT(*) as count FROM github_stats');
  if (dataCount.count === 0) {
    return true;
  }
  
  // Check if we have recent data (within last 24 hours)
  const latestUpdate = await dbGet(`
    SELECT MAX(last_updated) as latest_update 
    FROM github_stats
  `);
  
  if (latestUpdate?.latest_update) {
    const lastUpdate = new Date(latestUpdate.latest_update);
    const oneDayAgo = subDays(new Date(), 1);
    
    // Update if data is older than 24 hours
    if (lastUpdate < oneDayAgo) {
      return true;
    }
  }
  
  // Check if requested time range has gaps in our data
  if (fromDate && toDate) {
    const gapCheck = await dbGet(`
      SELECT COUNT(*) as count 
      FROM github_stats 
      WHERE week >= ? AND week <= ?
    `, [fromDate, toDate]);
    
    // If we have very little data for the requested range, update
    if (gapCheck.count < 5) {
      return true;
    }
  }
  
  return false;
}
