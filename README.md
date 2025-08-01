# Crous-scarper_bot

## Project Overview

**Crous-scarper_bot** is a Telegram-based automation tool designed to assist students in locating CROUS housing opportunities in France. It streamlines housing discovery by scraping listings, applying user-defined filters, and delivering structured results directly through chat.

## Purpose of Development

This project was initiated to improve the housing search experience for students. Its goals include:

- Reducing manual browsing time  
- Enabling real-time updates and filtered search results  
- Providing a responsive and accessible interface via Telegram  

The bot leverages automation to simplify decision-making and enhance user autonomy during housing periods.

## Key Features

- City-based search with intuitive pagination  
- Filter support for price, surface area, and property type  
- Live listing retrieval through web scraping  
- Search history tracking and alert configuration  
- Persistent user data stored via SQLite  
- Scheduled background tasks managed through cron jobs  

## Technologies Used

- **JavaScript (ES modules)**  
- **Node.js**  
- **node-telegram-bot-api** — Telegram integration  
- **cheerio** — HTML parsing for scraping  
- **node-fetch** — External data retrieval  
- **node-cron** — Task scheduling  
- **sqlite3** — Lightweight local database  
- **chalk** — Console styling for debugging  

## dependencies
```bash
# Install project dependencies
npm install
```
## Note:
node_modules folder is intentionally excluded from version control via .gitignore, as it can be fully regenerated from package.json using npm install

thank you : https://github.com/jackxripper


