/*
 ▛                          ▜
                              
   Author : Akshay Aradhya    
   GitHub : DollarAkshay      
   Date   : 2025-07-12        
                              
 ▙                          ▟
*/

import express from 'express';
import dotenv from 'dotenv';
import { aggregateStats } from './git.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8005;

// Enable CORS for Grafana
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main data endpoint for Grafana
app.get('/github-lines', async (req, res) => {
  try {
    // Extract time range from query parameters
    const { from, to } = req.query;
    
    console.log(`Fetching GitHub lines data from ${from} to ${to}`);
    
    // Fetch data with automatic caching/updating
    const data = await aggregateStats(from, to);
    
    res.json({
      data,
      meta: {
        total: data.length,
        from: from || null,
        to: to || null,
        generated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('Error fetching GitHub lines:', e);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: e.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Data endpoint: http://localhost:${PORT}/github-lines`);
});
