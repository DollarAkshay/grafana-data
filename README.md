# GitHub Lines Aggregator - Grafana Data Source

This service aggregates GitHub commit statistics (additions/deletions) by week and serves them as a Grafana-compatible data source.

## Features

- **Automatic Caching**: Uses SQLite for local caching with intelligent updates
- **Time Range Support**: Accepts `from` and `to` query parameters for time-based filtering
- **Grafana Compatible**: Designed to work as a Grafana data source
- **Rate Limiting Safe**: Includes delays to avoid GitHub API rate limits
- **Incremental Updates**: Only fetches new data since the last update

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your values:
   ```
   GITHUB_TOKEN=your_github_token_here
   ORG_NAME=your_org_name_here
   PORT=3000
   ```

3. **Run the Service**:
   ```bash
   npm start
   ```

## API Endpoints

- **GET `/github-lines`**: Main data endpoint
  - Query parameters: `from` (optional), `to` (optional)
  - Example: `/github-lines?from=2024-01-01&to=2024-12-31`
  - Automatically updates cache as needed

- **GET `/health`**: Health check endpoint
- **GET `/test`**: Test endpoint for Grafana data source testing

## Grafana Data Source Configuration

To configure this as a Grafana data source:

1. **Add Data Source**:
   - Go to Configuration → Data Sources
   - Click "Add data source"
   - Select "JSON API" or "Infinity" plugin

2. **Configure Connection**:
   - **URL**: `http://localhost:3000` (or your server URL)
   - **Method**: GET
   - **Path**: `/github-lines`

3. **Query Configuration**:
   - The service will automatically handle time range filtering
   - Data includes: `repo`, `week`, `additions`, `deletions`, `total_changes`, `timestamp`

## Data Structure

The API returns data in this format:
```json
{
  "data": [
    {
      "repo": "repository-name",
      "week": "2024-01-01",
      "additions": 150,
      "deletions": 50,
      "total_changes": 200,
      "timestamp": 1704067200000
    }
  ],
  "meta": {
    "total": 1,
    "from": "2024-01-01",
    "to": "2024-12-31",
    "generated_at": "2024-01-01T00:00:00.000Z"
  }
}
```

## Database

The service uses SQLite for caching with two tables:
- `github_stats`: Aggregated weekly statistics
- `commits_processed`: Tracks processed commits to avoid duplicates

Database file: `github_stats.db` (automatically created)

## Environment Variables

- `GITHUB_TOKEN`: GitHub Personal Access Token with repo access
- `ORG_NAME`: GitHub organization name
- `PORT`: Server port (default: 3000)

## Notes

- First run will take longer as it fetches all historical data
- Subsequent runs are much faster due to caching
- Data is automatically updated when accessed if it's older than 24 hours
- Time range queries help optimize performance
