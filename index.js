const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const cron = require("node-cron");
const sqlite3 = require("sqlite3").verbose();
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Enhanced Configuration with validation
const CONFIG = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "7651998703:AAHUDNJgFixhxPGJhPsTE0um78Cz32OM-bU",
  DB_PATH: "./bot_data.db",
  SCRAPE_TIMEOUT: 15000,
  MAX_RESULTS_PER_QUERY: 10,
  CRON_SCHEDULE: "0 9 * * 1", // Every Monday at 9 AM
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  MAX_RETRY_ATTEMPTS: 3,
  RATE_LIMIT_DELAY: 1000,
  SESSION_TIMEOUT: 300000, // 5 minutes
  MAX_CONCURRENT_SCRAPES: 3
};

// Enhanced Logger
class Logger {
  static log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${level.toUpperCase()}: ${message}`;

    console.log(logMessage);
    if (data) console.log(JSON.stringify(data, null, 2));

    // Optional: Write to file
    // fs.appendFileSync('bot.log', logMessage + '\n');
  }

  static info(message, data) { this.log('info', message, data); }
  static warn(message, data) { this.log('warn', message, data); }
  static error(message, data) { this.log('error', message, data); }
  static debug(message, data) { this.log('debug', message, data); }
}

// Enhanced Database Manager
class DatabaseManager extends EventEmitter {
  constructor(dbPath) {
    super();
    this.dbPath = dbPath;
    this.db = null;
    this.isConnected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          Logger.error('Database connection failed:', err);
          reject(err);
        } else {
          Logger.info('Database connected successfully');
          this.isConnected = true;
          this.initializeTables();
          resolve();
        }
      });
    });
  }

  initializeTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId INTEGER UNIQUE,
        email TEXT,
        location TEXT,
        priceMin INTEGER,
        priceMax INTEGER,
        surfaceMin INTEGER,
        surfaceMax INTEGER,
        propertyType TEXT,
        notifications BOOLEAN DEFAULT 1,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastActive DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId INTEGER,
        query TEXT,
        results INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chatId) REFERENCES users (chatId)
      )`,
      `CREATE TABLE IF NOT EXISTS scraped_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        price TEXT,
        location TEXT,
        url TEXT UNIQUE,
        description TEXT,
        images TEXT,
        scrapedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS user_sessions (
        chatId INTEGER PRIMARY KEY,
        currentStep TEXT,
        sessionData TEXT,
        expiresAt DATETIME,
        FOREIGN KEY (chatId) REFERENCES users (chatId)
      )`
    ];

    this.db.serialize(() => {
      tables.forEach(sql => {
        this.db.run(sql, (err) => {
          if (err) Logger.error('Table creation error:', err);
        });
      });
    });
  }

  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Database not connected'));
        return;
      }

      this.db.run(sql, params, function(err) {
        if (err) {
          Logger.error('Database run error:', { sql, params, error: err });
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }

  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Database not connected'));
        return;
      }

      this.db.get(sql, params, (err, row) => {
        if (err) {
          Logger.error('Database get error:', { sql, params, error: err });
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Database not connected'));
        return;
      }

      this.db.all(sql, params, (err, rows) => {
        if (err) {
          Logger.error('Database all error:', { sql, params, error: err });
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  close() {
    if (this.db) {
      this.db.close((err) => {
        if (err) Logger.error('Database close error:', err);
        else Logger.info('Database connection closed');
      });
    }
  }
}

// Enhanced Session Manager
class SessionManager {
  constructor(db) {
    this.db = db;
    this.sessions = new Map();
  }

  async createSession(chatId, step, data = {}) {
    const expiresAt = new Date(Date.now() + CONFIG.SESSION_TIMEOUT);
    const sessionData = JSON.stringify(data);

    try {
      await this.db.run(
        `INSERT OR REPLACE INTO user_sessions (chatId, currentStep, sessionData, expiresAt) VALUES (?, ?, ?, ?)`,
                        [chatId, step, sessionData, expiresAt.toISOString()]
      );

      this.sessions.set(chatId, { step, data, expiresAt });
      Logger.debug(`Session created for user ${chatId}:`, { step, data });
    } catch (error) {
      Logger.error('Session creation failed:', error);
    }
  }

  async getSession(chatId) {
    try {
      let session = this.sessions.get(chatId);

      if (!session) {
        const row = await this.db.get(
          `SELECT * FROM user_sessions WHERE chatId = ? AND expiresAt > datetime('now')`,
                                      [chatId]
        );

        if (row) {
          session = {
            step: row.currentStep,
            data: JSON.parse(row.sessionData || '{}'),
            expiresAt: new Date(row.expiresAt)
          };
          this.sessions.set(chatId, session);
        }
      }

      if (session && session.expiresAt < new Date()) {
        await this.clearSession(chatId);
        return null;
      }

      return session;
    } catch (error) {
      Logger.error('Session retrieval failed:', error);
      return null;
    }
  }

  async clearSession(chatId) {
    try {
      await this.db.run(`DELETE FROM user_sessions WHERE chatId = ?`, [chatId]);
      this.sessions.delete(chatId);
      Logger.debug(`Session cleared for user ${chatId}`);
    } catch (error) {
      Logger.error('Session clearing failed:', error);
    }
  }
}

// Enhanced Utility Functions
class BotUtils {
  static createKeyboard(items, prefix = "", columns = 2) {
    const keyboard = [];
    for (let i = 0; i < items.length; i += columns) {
      const row = items.slice(i, i + columns).map(item => ({
        text: item,
        callback_data: `${prefix}${item}`.substring(0, 64) // Telegram limit
      }));
      keyboard.push(row);
    }
    return keyboard;
  }

  static formatPrice(priceText) {
    if (!priceText) return "Prix non indiqué";
    const priceMatch = priceText.match(/(\d+(?:[.,]\d{2})?)/);
    return priceMatch ? `${priceMatch[1]}€/mois` : priceText;
  }

  static formatSurface(surfaceText) {
    if (!surfaceText) return "Surface non indiquée";
    const surfaceMatch = surfaceText.match(/(\d+(?:[.,]\d{2})?)\s*m²?/);
    return surfaceMatch ? `${surfaceMatch[1]}m²` : surfaceText;
  }

  static cleanText(text) {
    return text ? text.trim().replace(/\s+/g, ' ').substring(0, 200) : "";
  }

  static validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static escapeMarkdown(text) {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }
}

// Enhanced Scraping Engine with better error handling
class ScrapingEngine {
  constructor() {
    this.baseUrls = [
      "https://www.leboncoin.fr",
      "https://www.seloger.com",
      "https://www.pap.fr"
    ];
    this.activeScrapes = 0;
  }

  async scrapeListings(location, filters = {}) {
    if (this.activeScrapes >= CONFIG.MAX_CONCURRENT_SCRAPES) {
      throw new Error('Maximum concurrent scrapes reached');
    }

    this.activeScrapes++;
    const listings = [];

    try {
      Logger.info(`Starting scrape for ${location}`, { filters });

      const scrapePromises = this.baseUrls
      .slice(0, 2) // Limit to prevent overload
      .map(url => this.scrapeFromSiteWithRetry(url, location, filters));

      const results = await Promise.allSettled(scrapePromises);

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          listings.push(...result.value);
        } else {
          Logger.warn(`Scraping failed for ${this.baseUrls[index]}:`, result.reason);
        }
      });

      return this.deduplicateListings(listings.slice(0, CONFIG.MAX_RESULTS_PER_QUERY));

    } catch (error) {
      Logger.error('Scraping engine error:', error);
      throw error;
    } finally {
      this.activeScrapes--;
    }
  }

  async scrapeFromSiteWithRetry(baseUrl, location, filters, attempt = 1) {
    try {
      return await this.scrapeFromSite(baseUrl, location, filters);
    } catch (error) {
      if (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
        Logger.warn(`Retry attempt ${attempt} for ${baseUrl}:`, error.message);
        await BotUtils.sleep(1000 * attempt); // Exponential backoff
        return this.scrapeFromSiteWithRetry(baseUrl, location, filters, attempt + 1);
      }
      throw error;
    }
  }

  async scrapeFromSite(baseUrl, location, filters) {
    const searchUrl = this.buildSearchUrl(baseUrl, location, filters);
    Logger.debug(`Scraping URL: ${searchUrl}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.SCRAPE_TIMEOUT);

    try {
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': CONFIG.USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      return this.parseListings(html, baseUrl);

    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }

  buildSearchUrl(baseUrl, location, filters) {
    const params = new URLSearchParams();

    // Build URL based on site-specific patterns
    if (baseUrl.includes('leboncoin')) {
      params.append('locations', location);
      params.append('category', '10'); // Real estate category
      if (filters.priceMin) params.append('price', `${filters.priceMin}-${filters.priceMax || ''}`);
      return `${baseUrl}/annonces/offres/locations/?${params}`;
    } else if (baseUrl.includes('seloger')) {
      params.append('localisationIds', location);
      params.append('typeTransaction', '1'); // Rental
      if (filters.priceMin) params.append('prix', `${filters.priceMin}/${filters.priceMax || 'max'}`);
      return `${baseUrl}/list.htm?${params}`;
    } else {
      // Generic fallback
      params.append('location', location);
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
        return `${baseUrl}/search/?${params}`;
    }
  }

  parseListings(html, baseUrl) {
    const $ = cheerio.load(html);
    const listings = [];

    // Site-specific selectors
    const selectorSets = {
      'leboncoin': {
        container: '[data-qa-id="aditem_container"]',
        title: '[data-qa-id="aditem_title"]',
        price: '[data-qa-id="aditem_price"]',
        location: '[data-qa-id="aditem_location"]',
        url: 'a[data-qa-id="aditem_container"]'
      },
      'seloger': {
        container: '.c-pa-list',
        title: '.c-pa-link',
        price: '.c-pa-price',
        location: '.c-pa-city',
        url: '.c-pa-link'
      },
      'default': {
        container: '.ad, .annonce, .listing, .property, .card, .item, .result, article',
        title: '.title, h2, h3, .name, .ad-title, .property-title',
        price: '.price, .prix, .cost, [class*="price"]',
        location: '.location, .address, .city, .lieu',
        url: 'a'
      }
    };

    const domain = new URL(baseUrl).hostname;
    const selectors = selectorSets[Object.keys(selectorSets).find(key => domain.includes(key))] || selectorSets.default;

    $(selectors.container).each((index, element) => {
      if (listings.length >= CONFIG.MAX_RESULTS_PER_QUERY) return false;

      const $el = $(element);
      const listing = this.extractListingData($el, baseUrl, selectors);

      if (listing && listing.title && listing.title.length > 5) {
        listings.push(listing);
      }
    });

    return listings;
  }

  extractListingData($element, baseUrl, selectors) {
    try {
      const title = this.extractText($element, selectors.title);
      const price = this.extractText($element, selectors.price);
      const location = this.extractText($element, selectors.location);
      const description = this.extractText($element, '.description, .desc, .details');

      // Extract URL
      let url = $element.find(selectors.url).first().attr('href') || '';
      if (url && !url.startsWith('http')) {
        url = new URL(url, baseUrl).href;
      }

      // Extract images
      const images = [];
      $element.find('img').each((_, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy');
        if (src && !src.includes('placeholder') && !src.includes('loading')) {
          const fullSrc = src.startsWith('http') ? src : new URL(src, baseUrl).href;
          images.push(fullSrc);
        }
      });

      return {
        title: BotUtils.cleanText(title),
        price: BotUtils.formatPrice(price),
        location: BotUtils.cleanText(location),
        description: BotUtils.cleanText(description),
        url: url,
        images: images.slice(0, 2),
        source: new URL(baseUrl).hostname,
        scrapedAt: new Date().toISOString()
      };
    } catch (error) {
      Logger.error('Error extracting listing data:', error);
      return null;
    }
  }

  extractText($element, selector) {
    const text = $element.find(selector).first().text().trim();
    return text || null;
  }

  deduplicateListings(listings) {
    const seen = new Set();
    return listings.filter(listing => {
      const key = `${listing.title}_${listing.price}_${listing.location}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// Enhanced Bot Class
class EnhancedTelegramBot {
  constructor() {
    this.db = new DatabaseManager(CONFIG.DB_PATH);
    this.scraper = new ScrapingEngine();
    this.sessions = null;
    this.bot = null;
    this.stats = {
      totalUsers: 0,
      totalSearches: 0,
      lastUpdate: new Date(),
      uptime: Date.now()
    };
    this.messageQueue = [];
    this.processingQueue = false;
  }

  async initialize() {
    try {
      await this.db.connect();
      this.sessions = new SessionManager(this.db);

      this.bot = new TelegramBot(CONFIG.BOT_TOKEN, {
        polling: {
          interval: 1000,
          autoStart: true,
          params: {
            timeout: 10
          }
        }
      });

      this.setupEventHandlers();
      this.setupCommands();
      this.setupScheduledTasks();

      Logger.info("Enhanced Telegram Bot initialized successfully");

    } catch (error) {
      Logger.error("Bot initialization failed:", error);
      throw error;
    }
  }

  setupEventHandlers() {
    this.bot.on('polling_error', (error) => {
      Logger.error('Polling error:', error);
    });

    this.bot.on('error', (error) => {
      Logger.error('Bot error:', error);
    });

    // Global message handler with session support
    this.bot.on('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        await this.handleSessionMessage(msg);
      }
    });
  }

  async handleSessionMessage(msg) {
    const chatId = msg.chat.id;
    const session = await this.sessions.getSession(chatId);

    if (!session) return;

    try {
      switch (session.step) {
        case 'awaiting_city':
          await this.handleCityInput(chatId, msg.text.trim());
          break;
        case 'awaiting_email':
          await this.handleEmailInput(chatId, msg.text.trim());
          break;
        case 'awaiting_price_min':
          await this.handlePriceMinInput(chatId, msg.text.trim());
          break;
        case 'awaiting_price_max':
          await this.handlePriceMaxInput(chatId, msg.text.trim());
          break;
        default:
          await this.sessions.clearSession(chatId);
      }
    } catch (error) {
      Logger.error('Session message handling error:', error);
      await this.sendMessage(chatId, "❌ Une erreur s'est produite. Veuillez réessayer.");
      await this.sessions.clearSession(chatId);
    }
  }

  setupCommands() {
    // Start command
    this.bot.onText(/\/start/, async (msg) => {
      await this.handleStart(msg);
    });

    // Search command
    this.bot.onText(/\/search/, async (msg) => {
      await this.handleSearch(msg);
    });

    // Filter command
    this.bot.onText(/\/filter/, async (msg) => {
      await this.handleFilter(msg);
    });

    // Alerts command
    this.bot.onText(/\/alerts/, async (msg) => {
      await this.handleAlerts(msg);
    });

    // Stats command
    this.bot.onText(/\/stats/, async (msg) => {
      await this.handleStats(msg);
    });

    // Help command
    this.bot.onText(/\/help/, async (msg) => {
      await this.handleHelp(msg);
    });

    // Callback query handler
    this.bot.on("callback_query", async (query) => {
      await this.handleCallbackQuery(query);
    });
  }

  async handleStart(msg) {
    const chatId = msg.chat.id;
    await this.logUserActivity(chatId);
    await this.sessions.clearSession(chatId);

    try {
      await this.db.run(`INSERT OR IGNORE INTO users (chatId) VALUES (?)`, [chatId]);

      const locations = [
        "Paris", "Lyon", "Marseille", "Toulouse", "Nice", "Nantes", "Strasbourg",
        "Montpellier", "Bordeaux", "Lille", "Rennes", "Reims", "Grenoble",
        "Rouen", "Dijon", "Le Havre", "Saint-Étienne", "Toulon", "Angers",
        "Amiens", "Metz", "Besançon", "Tours", "Limoges", "Perpignan"
      ];

      const keyboard = BotUtils.createKeyboard(locations.slice(0, 20), "city_", 2);
      keyboard.push([{ text: "🔍 Recherche personnalisée", callback_data: "custom_search" }]);

      const welcomeMessage = `🏠 *Bienvenue sur le Bot Crousscarper* 🇫🇷

      🔍 *Fonctionnalités disponibles :*
      • Recherche de logements par ville
      • Filtres personnalisés (prix, surface, type)
      • Alertes par email
      • Suivi des recherches
      • Statistiques en temps réel

      📋 *Commandes utiles :*
      /search - Recherche rapide
      /filter - Définir vos filtres
      /alerts - Gérer les alertes
      /stats - Voir les statistiques
      /help - Aide complète

      🛠️ *Support technique :*
      • Essayez /start en cas de problème
      • Contact : https://www.instagram.com/j1ckxr3ipp3r/

      👇 *Choisissez une ville pour commencer :*`;

      await this.sendMessage(chatId, welcomeMessage, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: "Markdown"
      });

    } catch (error) {
      Logger.error('Start command error:', error);
      await this.sendMessage(chatId, "❌ Erreur lors de l'initialisation. Veuillez réessayer.");
    }
  }

  async handleSearch(msg) {
    const chatId = msg.chat.id;
    await this.logUserActivity(chatId);

    await this.sessions.createSession(chatId, 'awaiting_city');
    await this.sendMessage(chatId, "🏙️ Tapez le nom de la ville où vous cherchez un logement :");
  }

  async handleCityInput(chatId, city) {
    if (!city || city.length < 2) {
      await this.sendMessage(chatId, "❌ Nom de ville invalide. Veuillez entrer un nom valide :");
      return;
    }

    await this.sessions.clearSession(chatId);
    await this.performCitySearch(chatId, city);
  }

  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id;
    const data = query.data;

    await this.logUserActivity(chatId);

    try {
      if (data.startsWith("city_")) {
        const city = data.replace("city_", "");
        await this.performCitySearch(chatId, city);
      } else if (data === "custom_search") {
        await this.sessions.createSession(chatId, 'awaiting_city');
        await this.sendMessage(chatId, "🏙️ Tapez le nom de la ville recherchée :");
      } else if (data.startsWith("filter_")) {
        await this.handleFilterCallback(chatId, data);
      }

      await this.bot.answerCallbackQuery(query.id);
    } catch (error) {
      Logger.error('Callback query error:', error);
      await this.bot.answerCallbackQuery(query.id, "❌ Erreur lors du traitement");
    }
  }

  async performCitySearch(chatId, city) {
    const loadingMsg = await this.sendMessage(chatId, `🔍 Recherche de logements à ${city}...`);

    try {
      const user = await this.getUserData(chatId);
      const filters = {
        priceMin: user?.priceMin,
        priceMax: user?.priceMax,
        surfaceMin: user?.surfaceMin,
        surfaceMax: user?.surfaceMax,
        propertyType: user?.propertyType
      };

      const listings = await this.scraper.scrapeListings(city, filters);

      await this.db.run(
        `INSERT INTO searches (chatId, query, results) VALUES (?, ?, ?)`,
                        [chatId, city, listings.length]
      );

      if (listings.length === 0) {
        await this.editMessage(chatId, loadingMsg.message_id,
                               `😕 Aucun logement trouvé à ${city} avec vos critères actuels.

                               💡 *Suggestions :*
                               • Modifiez vos filtres avec /filter
                               • Essayez une ville voisine
                               • Configurez une alerte avec /alerts`);
        return;
      }

      // Send summary
      const summary = this.generateSearchSummary(listings, city);
      await this.editMessage(chatId, loadingMsg.message_id, summary, { parse_mode: "Markdown" });

      // Send individual listings
      const maxListings = Math.min(listings.length, 5);
      for (let i = 0; i < maxListings; i++) {
        const message = this.formatListingMessage(listings[i], i + 1);
        await this.sendMessage(chatId, message, {
          parse_mode: "Markdown",
          disable_web_page_preview: false
        });
        await BotUtils.sleep(CONFIG.RATE_LIMIT_DELAY);
      }

      if (listings.length > 5) {
        await this.sendMessage(chatId,
                               `📄 Affichage des 5 premiers résultats sur ${listings.length}.

                               🔄 Utilisez /search pour une nouvelle recherche ou /filter pour affiner vos critères.`);
      }

    } catch (error) {
      Logger.error(`City search error for ${city}:`, error);
      await this.editMessage(chatId, loadingMsg.message_id,
                             `❌ Erreur lors de la recherche à ${city}. Veuillez réessayer plus tard.`);
    }
  }

  async handleAlerts(msg) {
    const chatId = msg.chat.id;
    await this.logUserActivity(chatId);

    await this.sessions.createSession(chatId, 'awaiting_email');
    await this.sendMessage(chatId, "📧 Entrez votre email pour recevoir des alertes (ou 'off' pour désactiver) :");
  }

  async handleEmailInput(chatId, email) {
    if (email.toLowerCase() === 'off') {
      await this.db.run(`UPDATE users SET email = NULL, notifications = 0 WHERE chatId = ?`, [chatId]);
      await this.sendMessage(chatId, "🔕 Alertes désactivées.");
    } else if (BotUtils.validateEmail(email)) {
      await this.db.run(`UPDATE users SET email = ?, notifications = 1 WHERE chatId = ?`, [email, chatId]);
      await this.sendMessage(chatId, `✅ Alertes activées pour : ${email}`);
    } else {
      await this.sendMessage(chatId, "❌ Email invalide. Veuillez entrer un email valide :");
      return; // Don't clear session, wait for valid input
    }

    await this.sessions.clearSession(chatId);
  }

  async handleStats(msg) {
    const chatId = msg.chat.id;
    await this.logUserActivity(chatId);

    try {
      const [userSearches, totalUsers, totalSearches] = await Promise.all([
        this.db.get(`SELECT COUNT(*) as count FROM searches WHERE chatId = ?`, [chatId]),
                                                                          this.db.get(`SELECT COUNT(*) as count FROM users`),
                                                                          this.db.get(`SELECT COUNT(*) as count FROM searches`)
      ]);

      const uptime = Math.floor((Date.now() - this.stats.uptime) / 3600000);
      const statsMessage = `📊 *Statistiques du Bot*

      👤 *Vos statistiques :*
      • Recherches effectuées : ${userSearches?.count || 0}

      🌐 *Statistiques globales :*
      • Utilisateurs actifs : ${totalUsers?.count || 0}
      • Recherches totales : ${totalSearches?.count || 0}
      • Uptime : ${uptime}h

      🔧 *Système :*
      • Dernière mise à jour : ${this.stats.lastUpdate.toLocaleDateString('fr-FR')}
      • Scrapage actifs : ${this.scraper.activeScrapes}/${CONFIG.MAX_CONCURRENT_SCRAPES}`;

      await this.sendMessage(chatId, statsMessage, { parse_mode: "Markdown" });

    } catch (error) {
      Logger.error('Stats command error:', error);
      await this.sendMessage(chatId, "❌ Erreur lors de la récupération des statistiques.");
    }
  }

  async handleFilter(msg) {
    const chatId = msg.chat.id;
    await this.logUserActivity(chatId);

    try {
      const user = await this.getUserData(chatId);

      const filterKeyboard = [
        [
          { text: "💰 Prix minimum", callback_data: "filter_price_min" },
          { text: "💸 Prix maximum", callback_data: "filter_price_max" }
        ],
        [
          { text: "📏 Surface minimum", callback_data: "filter_surface_min" },
          { text: "📐 Surface maximum", callback_data: "filter_surface_max" }
        ],
        [
          { text: "🏠 Type de bien", callback_data: "filter_property_type" }
        ],
        [
          { text: "🗑️ Réinitialiser", callback_data: "filter_reset" },
          { text: "✅ Terminé", callback_data: "filter_done" }
        ]
      ];

      const currentFilters = `🔧 *Configuration actuelle :*

      💰 Prix : ${user?.priceMin || 'Non défini'} - ${user?.priceMax || 'Non défini'}€
      📏 Surface : ${user?.surfaceMin || 'Non défini'} - ${user?.surfaceMax || 'Non défini'}m²
      🏠 Type : ${user?.propertyType || 'Tous types'}

      👇 *Choisissez un paramètre à modifier :*`;

      await this.sendMessage(chatId, currentFilters, {
        reply_markup: { inline_keyboard: filterKeyboard },
        parse_mode: "Markdown"
      });

    } catch (error) {
      Logger.error('Filter command error:', error);
      await this.sendMessage(chatId, "❌ Erreur lors de l'affichage des filtres.");
    }
  }

  async handleFilterCallback(chatId, data) {
    const filterType = data.replace("filter_", "");

    switch (filterType) {
      case "price_min":
        await this.sessions.createSession(chatId, 'awaiting_price_min');
        await this.sendMessage(chatId, "💰 Entrez le prix minimum (€/mois) :");
        break;
      case "price_max":
        await this.sessions.createSession(chatId, 'awaiting_price_max');
        await this.sendMessage(chatId, "💸 Entrez le prix maximum (€/mois) :");
        break;
      case "surface_min":
        await this.sessions.createSession(chatId, 'awaiting_surface_min');
        await this.sendMessage(chatId, "📏 Entrez la surface minimum (m²) :");
        break;
      case "surface_max":
        await this.sessions.createSession(chatId, 'awaiting_surface_max');
        await this.sendMessage(chatId, "📐 Entrez la surface maximum (m²) :");
        break;
      case "property_type":
        const propertyTypes = ["Appartement", "Maison", "Studio", "Loft", "Chambre"];
        const keyboard = BotUtils.createKeyboard(propertyTypes, "property_", 2);
        await this.sendMessage(chatId, "🏠 Choisissez le type de bien :", {
          reply_markup: { inline_keyboard: keyboard }
        });
        break;
      case "reset":
        await this.db.run(`UPDATE users SET priceMin = NULL, priceMax = NULL, surfaceMin = NULL, surfaceMax = NULL, propertyType = NULL WHERE chatId = ?`, [chatId]);
        await this.sendMessage(chatId, "🗑️ Filtres réinitialisés !");
        break;
      case "done":
        await this.sendMessage(chatId, "✅ Configuration des filtres terminée !");
        break;
    }
  }

  async handlePriceMinInput(chatId, input) {
    const price = parseInt(input);
    if (isNaN(price) || price < 0) {
      await this.sendMessage(chatId, "❌ Prix invalide. Entrez un nombre valide :");
      return;
    }

    await this.db.run(`UPDATE users SET priceMin = ? WHERE chatId = ?`, [price, chatId]);
    await this.sendMessage(chatId, `✅ Prix minimum défini : ${price}€/mois`);
    await this.sessions.clearSession(chatId);
  }

  async handlePriceMaxInput(chatId, input) {
    const price = parseInt(input);
    if (isNaN(price) || price < 0) {
      await this.sendMessage(chatId, "❌ Prix invalide. Entrez un nombre valide :");
      return;
    }

    await this.db.run(`UPDATE users SET priceMax = ? WHERE chatId = ?`, [price, chatId]);
    await this.sendMessage(chatId, `✅ Prix maximum défini : ${price}€/mois`);
    await this.sessions.clearSession(chatId);
  }

  async handleHelp(msg) {
    const chatId = msg.chat.id;
    await this.logUserActivity(chatId);

    const helpMessage = `🆘 *Guide d'utilisation du Bot Crousscarper*

    🔍 *Commandes principales :*
    • /start - Accueil et recherche rapide
    • /search - Recherche par ville
    • /filter - Configurer vos critères
    • /alerts - Gérer les alertes email
    • /stats - Voir vos statistiques
    • /help - Afficher cette aide

    🏠 *Comment utiliser le bot :*

    1️⃣ *Première utilisation :*
    • Tapez /start pour commencer
    • Choisissez une ville dans la liste
    • Consultez les résultats

    2️⃣ *Personnaliser la recherche :*
    • Utilisez /filter pour définir :
    - Prix minimum/maximum
    - Surface minimum/maximum
    - Type de logement
    • Sauvegardez avec ✅ Terminé

    3️⃣ *Recevoir des alertes :*
    • Tapez /alerts
    • Entrez votre email
    • Recevez les nouvelles annonces

    🔧 *Conseils d'utilisation :*
    • Soyez précis dans vos critères
    • Vérifiez régulièrement les alertes
    • Utilisez /stats pour suivre vos recherches

    ⚠️ *En cas de problème :*
    • Tapez /start pour redémarrer
    • Contactez le support : https://www.instagram.com/j1ckxr3ipp3r/

    🌟 *Fonctionnalités avancées :*
    • Recherche multi-sites (LeBonCoin, SeLoger, PAP)
    • Déduplication automatique
    • Sauvegarde des préférences
    • Statistiques détaillées`;

    await this.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
  }

  generateSearchSummary(listings, city) {
    const avgPrice = listings
    .map(l => parseInt(l.price.match(/\d+/) || [0]))
    .filter(p => p > 0)
    .reduce((a, b, _, arr) => a + b / arr.length, 0);

    const sources = [...new Set(listings.map(l => l.source))];

    return `✅ *Recherche terminée pour ${city}*

    📊 *Résultats :*
    • ${listings.length} logement(s) trouvé(s)
    • Prix moyen : ~${Math.round(avgPrice)}€/mois
    • Sources : ${sources.join(', ')}

    🏠 *Annonces ci-dessous* 👇`;
  }

  formatListingMessage(listing, index) {
    let message = `🏠 *Annonce ${index}*

    📍 **${listing.title}**
    💰 ${listing.price}
    📍 ${listing.location}`;

    if (listing.description) {
      message += `\n📝 ${listing.description}`;
    }

    if (listing.url) {
      message += `\n\n🔗 [Voir l'annonce complète](${listing.url})`;
    }

    message += `\n\n🌐 Source : ${listing.source}`;

    return message;
  }

  setupScheduledTasks() {
    // Weekly alert system
    cron.schedule(CONFIG.CRON_SCHEDULE, async () => {
      Logger.info('Running scheduled alert system');
      await this.sendWeeklyAlerts();
    });

    // Daily cleanup
    cron.schedule('0 0 * * *', async () => {
      Logger.info('Running daily cleanup');
      await this.cleanupExpiredSessions();
      await this.updateStats();
    });
  }

  async sendWeeklyAlerts() {
    try {
      const users = await this.db.all(`SELECT * FROM users WHERE notifications = 1 AND email IS NOT NULL`);

      for (const user of users) {
        try {
          const filters = {
            priceMin: user.priceMin,
            priceMax: user.priceMax,
            surfaceMin: user.surfaceMin,
            surfaceMax: user.surfaceMax,
            propertyType: user.propertyType
          };

          // Mock location - in real implementation, you'd store user's preferred locations
          const listings = await this.scraper.scrapeListings(user.location || 'Paris', filters);

          if (listings.length > 0) {
            const alertMessage = `🚨 *Alerte Hebdomadaire - Nouveaux Logements*

            📊 ${listings.length} nouveau(x) logement(s) correspondent à vos critères !

            🔍 Utilisez /search pour voir les détails complets.`;

            await this.sendMessage(user.chatId, alertMessage, { parse_mode: "Markdown" });
          }

          await BotUtils.sleep(2000); // Rate limiting
        } catch (error) {
          Logger.error(`Alert error for user ${user.chatId}:`, error);
        }
      }
    } catch (error) {
      Logger.error('Weekly alerts error:', error);
    }
  }

  async cleanupExpiredSessions() {
    try {
      await this.db.run(`DELETE FROM user_sessions WHERE expiresAt < datetime('now')`);
      Logger.info('Expired sessions cleaned up');
    } catch (error) {
      Logger.error('Session cleanup error:', error);
    }
  }

  async updateStats() {
    try {
      const [users, searches] = await Promise.all([
        this.db.get(`SELECT COUNT(*) as count FROM users`),
                                                  this.db.get(`SELECT COUNT(*) as count FROM searches`)
      ]);

      this.stats.totalUsers = users?.count || 0;
      this.stats.totalSearches = searches?.count || 0;
      this.stats.lastUpdate = new Date();

      Logger.info('Stats updated:', this.stats);
    } catch (error) {
      Logger.error('Stats update error:', error);
    }
  }

  async getUserData(chatId) {
    try {
      const user = await this.db.get(`SELECT * FROM users WHERE chatId = ?`, [chatId]);
      return user;
    } catch (error) {
      Logger.error('Get user data error:', error);
      return null;
    }
  }

  async logUserActivity(chatId) {
    try {
      await this.db.run(`UPDATE users SET lastActive = CURRENT_TIMESTAMP WHERE chatId = ?`, [chatId]);
    } catch (error) {
      Logger.error('User activity logging error:', error);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      Logger.error('Send message error:', { chatId, error: error.message });
      throw error;
    }
  }

  async editMessage(chatId, messageId, text, options = {}) {
    try {
      return await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...options
      });
    } catch (error) {
      Logger.error('Edit message error:', { chatId, messageId, error: error.message });
      // Fallback: send new message if edit fails
      return await this.sendMessage(chatId, text, options);
    }
  }

  async gracefulShutdown() {
    Logger.info('Initiating graceful shutdown...');

    try {
      if (this.bot) {
        await this.bot.stopPolling();
        Logger.info('Bot polling stopped');
      }

      if (this.db) {
        this.db.close();
        Logger.info('Database connection closed');
      }

      Logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      Logger.error('Shutdown error:', error);
      process.exit(1);
    }
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  Logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  Logger.info('Received SIGINT signal');
  if (global.botInstance) {
    await global.botInstance.gracefulShutdown();
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', async () => {
  Logger.info('Received SIGTERM signal');
  if (global.botInstance) {
    await global.botInstance.gracefulShutdown();
  } else {
    process.exit(0);
  }
});

// Main execution
async function main() {
  try {
    Logger.info('Starting Enhanced Telegram Bot...');

    // Validate required configuration
    if (!CONFIG.BOT_TOKEN || CONFIG.BOT_TOKEN === "YOUR_BOT_TOKEN_HERE") {
      throw new Error('Bot token not configured. Please set TELEGRAM_BOT_TOKEN environment variable.');
    }

    const bot = new EnhancedTelegramBot();
    global.botInstance = bot;

    await bot.initialize();

    Logger.info('🚀 Enhanced Telegram Bot is now running!');
    Logger.info(`📊 Configuration: ${JSON.stringify({
      timeout: CONFIG.SCRAPE_TIMEOUT,
      maxResults: CONFIG.MAX_RESULTS_PER_QUERY,
      cronSchedule: CONFIG.CRON_SCHEDULE,
      maxConcurrentScrapes: CONFIG.MAX_CONCURRENT_SCRAPES
    }, null, 2)}`);

  } catch (error) {
    Logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Start the bot if this file is run directly
if (require.main === module) {
  main();
}

module.exports = {
  EnhancedTelegramBot,
  DatabaseManager,
  ScrapingEngine,
  SessionManager,
  BotUtils,
  Logger,
  CONFIG
};
