import fetch from 'node-fetch';
import { parseISO, formatISO, subHours } from 'date-fns';
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
            additions INTEGER DEFAULT 0,
            deletions INTEGER DEFAULT 0,
            committed_at TEXT NOT NULL,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await dbRun(`
        CREATE TABLE IF NOT EXISTS commits_processed (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo TEXT NOT NULL,
            sha TEXT NOT NULL,
            committed_at TEXT NOT NULL,
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

async function isCommitProcessed(repo, sha) {
    const result = await dbGet(`
        SELECT COUNT(*) as count 
        FROM commits_processed 
        WHERE repo = ? AND sha = ?
    `, [repo, sha]);
    return result.count > 0;
}

async function markCommitProcessed(repo, sha, committedAt) {
    await dbRun(`
        INSERT OR IGNORE INTO commits_processed (repo, sha, committed_at) 
        VALUES (?, ?, ?)
    `, [repo, sha, committedAt]);
}

async function insertCommitStats(repo, additions, deletions, committedAt) {
    await dbRun(`
        INSERT INTO github_stats (repo, additions, deletions, committed_at, last_updated)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [repo, additions, deletions, committedAt]);
}

async function updateStats() {
    // Get the latest update timestamp from the database
    const latestUpdate = await dbGet(`
        SELECT MAX(last_updated) as latest_update 
        FROM github_stats
    `);
    
    // Determine the since date for fetching, with a 2-hour buffer to avoid DST and timing issues
    let sinceDate = INITIAL_SINCE_DATE;
    if (latestUpdate?.latest_update) {
        const latest = parseISO(latestUpdate.latest_update);
        const bufferDate = subHours(latest, 2); // minus 2 hours using date-fns
        sinceDate = formatISO(bufferDate);
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
            
            const committedAt = commit.commit.author.date; // ISO datetime string
            
            try {
                const stats = await fetchCommitStats(repo, commit.sha);
                await insertCommitStats(repo, stats.additions, stats.deletions, committedAt);
                await markCommitProcessed(repo, commit.sha, committedAt);
            } 
            catch (error) {
                console.error(`Error processing commit ${commit.sha} for ${repo}:`, error);
            }
        }
    }
    
    console.log('Stats update completed');
}

export async function aggregateStats(fromTimeMs, toTimeMs) {
    // Convert timestamps to date strings
    const fromDateTime = formatISO(new Date(parseInt(fromTimeMs)));
    const toDateTime = formatISO(new Date(parseInt(toTimeMs)));

    // Always update data to get the latest commits
    await updateStats();

    // Query data for the specified time range, grouped by date alias
    const query = `
        SELECT DATE(committed_at) as date, SUM(additions) as additions, SUM(deletions) as deletions, MAX(last_updated) as last_updated
        FROM github_stats 
        WHERE committed_at >= ? AND committed_at <= ?
        GROUP BY date
        ORDER BY date DESC
    `;

    const results = await dbAll(query, [fromDateTime, toDateTime]);

    // Transform data for Grafana compatibility
    return results.map(row => ({
        date: row.date,
        additions: row.additions,
        deletions: row.deletions,
        total_changes: row.additions + row.deletions,
        timestamp: new Date(row.date).getTime() // Add timestamp for Grafana
    }));
}