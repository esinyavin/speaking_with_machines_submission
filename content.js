class TwitterContentFilter {
    constructor() {
      this.filters = [];
      this.processedTweets = new Set();
      this.isProcessing = false;
      this.worker = null;
      this.aiAvailable = false;
      this.pendingRequests = new Map();
      this.initializeFilter();
    }
  
    async initializeFilter() {
      // Initialize DeepSeek worker
      await this.initializeDeepSeek();
      
      // Load filters from storage
      await this.loadFilters();
      
      // Start observing for new tweets
      this.startObserving();
      
      // Process existing tweets
      this.processTweets();
      
      // Listen for messages from popup
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'updateFilters') {
          this.filters = message.filters;
          this.processTweets();
          sendResponse({ success: true });
        } else if (message.action === 'getAIStatus') {
          sendResponse({ 
            aiAvailable: this.aiAvailable,
            isLoading: this.worker && !this.aiAvailable,
            workerExists: !!this.worker
          });
        }
        return true; // Keep message channel open for async response
      });
    }
  
    async initializeDeepSeek() {
      try {
        console.log('🤖 Initializing API connection via background script...');
        
        // Check API status via background script
        const result = await chrome.runtime.sendMessage({ action: 'checkAPI' });
        
        if (result.available) {
          this.aiAvailable = true;
          console.log(`✅ API connected: ${result.model}`);
        } else {
          this.aiAvailable = false;
          console.log(`❌ API connection failed: ${result.error}`);
        }
      } catch (error) {
        console.log('❌ Error checking API via background script:', error);
        this.aiAvailable = false;
      }
    }
  
    async loadFilters() {
      try {
        const result = await chrome.storage.sync.get(['filters']);
        this.filters = result.filters || [];
      } catch (error) {
        console.error('Error loading filters:', error);
      }
    }
  
    startObserving() {
      // Observer for dynamically loaded tweets
      const observer = new MutationObserver((mutations) => {
        if (!this.isProcessing) {
          this.isProcessing = true;
          setTimeout(() => {
            this.processTweets();
            this.isProcessing = false;
          }, 100);
        }
      });
  
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  
    async processTweets() {
      if (this.filters.length === 0) return;

      // Twitter/X selectors for tweets
      const tweetSelectors = [
        '[data-testid="tweet"]',
        '[data-testid="tweetText"]',
        'article[role="article"]'
      ];

      // Collect unprocessed tweets and prepare batch entries
      const batchEntries = [];

      for (const selector of tweetSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (this.processedTweets.has(el)) continue; // skip already handled

          const tweetText = this.extractTweetText(el);
          if (!tweetText) continue; // nothing to evaluate

          const imageSources = Array.from(el.querySelectorAll('img')).map(img => img.src);

          batchEntries.push([el, { text: tweetText, images: imageSources }]);
          this.processedTweets.add(el);
        }
        // Stop once we have collected some tweets for this round
        if (batchEntries.length > 0) break;
      }

      if (batchEntries.length === 0) return;

      // Send the collected tweets for batch filtering
      const results = await this.batchFilterContent(batchEntries);

      // Apply filtering decisions to corresponding tweet elements
      results.forEach((res, idx) => {
        if (res && res.shouldFilter) {
          const tweetElement = batchEntries[idx][0];
          this.applyFilter(tweetElement, res.reason, res.confidence, res.method);
        }
      });
    }
  
    extractTweetText(tweetElement) {
      // Try different selectors to get tweet text
      const textSelectors = [
        '[data-testid="tweetText"]',
        '[lang]',
        '.tweet-text',
        '.js-tweet-text',
        'span'
      ];
  
      let text = '';
      for (const selector of textSelectors) {
        const textElement = tweetElement.querySelector(selector);
        if (textElement) {
          text += textElement.textContent + ' ';
        }
      }
  
      return text.trim();
    }
  
    async batchFilterContent(batchEntries) {
      try {
        // Debug: Log batch processing
        console.log('🤖 API batch analyzing:', batchEntries.length, 'tweets');
        console.log('🤖 Against filters:', this.filters);
        
        // Prepare batch data for background script
        const batchData = batchEntries.map(([tweetId, tweetData], index) => ({
          id: tweetId,
          index: index,
          text: tweetData.text,
          hasImages: tweetData.images.length > 0
        }));
        
        // Send batch filtering request to background script
        const results = await chrome.runtime.sendMessage({
          action: 'filterBatch',
          tweets: batchData,
          filters: this.filters
        });
        
        // Debug: Log batch results
        console.log('🤖 API batch results:', results);
        return results;
        
      } catch (error) {
        console.log('❌ Batch filtering error:', error);
        
        // Return default results for all tweets if batch fails
        return batchEntries.map(() => ({ 
          shouldFilter: false, 
          confidence: '0%', 
          method: 'Batch Error',
          reason: 'Batch processing failed',
          details: error.message || 'Unknown error'
        }));
      }
    }
  
    keywordFilterContent(text) {
      // Fallback keyword-based filtering
      const lowerText = text.toLowerCase();
      
      for (const filter of this.filters) {
        const filterWords = filter.toLowerCase().split(' ');
        const matchCount = filterWords.filter(word => 
          lowerText.includes(word) || this.semanticMatch(lowerText, word)
        ).length;
        
        // If more than half of the filter words match, consider it a match
        if (matchCount >= Math.ceil(filterWords.length / 2)) {
          return {
            shouldFilter: true,
            reason: filter,
            confidence: `${(matchCount / filterWords.length * 100).toFixed(0)}%`,
            method: 'Keywords'
          };
        }
      }
  
      return { shouldFilter: false, method: 'Keywords' };
    }
  
    semanticMatch(text, filterWord) {
      // Enhanced semantic matching with more comprehensive synonyms
      const synonyms = {
        // Politics
        'political': ['politics', 'election', 'vote', 'voting', 'government', 'politician', 'congress', 'senate', 'president', 'democratic', 'republican', 'liberal', 'conservative', 'policy', 'campaign', 'ballot', 'candidate'],
        'politics': ['political', 'election', 'vote', 'voting', 'government', 'politician', 'congress', 'senate', 'president', 'democratic', 'republican', 'liberal', 'conservative', 'policy', 'campaign'],
        
        // Cryptocurrency  
        'crypto': ['cryptocurrency', 'bitcoin', 'ethereum', 'blockchain', 'nft', 'defi', 'web3', 'metaverse', 'token', 'coin', 'mining', 'wallet', 'exchange', 'trading'],
        'cryptocurrency': ['crypto', 'bitcoin', 'ethereum', 'blockchain', 'nft', 'defi', 'web3', 'metaverse', 'token', 'coin', 'mining'],
        'bitcoin': ['btc', 'crypto', 'cryptocurrency', 'blockchain', 'mining', 'satoshi'],
        
        // Sports
        'sports': ['football', 'basketball', 'soccer', 'baseball', 'tennis', 'golf', 'hockey', 'game', 'match', 'tournament', 'championship', 'playoff', 'season', 'team', 'player', 'coach', 'stadium', 'league'],
        'football': ['nfl', 'quarterback', 'touchdown', 'superbowl', 'sports', 'game', 'match'],
        'basketball': ['nba', 'playoffs', 'championship', 'sports', 'game', 'match', 'court'],
        
        // Negative content
        'negative': ['sad', 'angry', 'hate', 'terrible', 'awful', 'bad', 'depressing', 'tragic', 'horrible', 'devastating', 'outrage', 'disgusting', 'shocking'],
        'toxic': ['hate', 'angry', 'disgusting', 'terrible', 'awful', 'horrible', 'nasty', 'mean'],
        
        // News/Breaking
        'news': ['breaking', 'report', 'update', 'alert', 'happening', 'developing', 'latest', 'urgent', 'exclusive', 'story'],
        'breaking': ['news', 'alert', 'urgent', 'developing', 'happening', 'latest', 'update'],
        
        // Technology
        'tech': ['technology', 'software', 'hardware', 'computer', 'programming', 'coding', 'developer', 'startup', 'innovation'],
        'ai': ['artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'chatgpt', 'openai', 'anthropic'],
        
        // Entertainment
        'celebrity': ['famous', 'star', 'actor', 'actress', 'singer', 'musician', 'influencer', 'tiktoker', 'youtuber'],
        'music': ['song', 'album', 'artist', 'band', 'concert', 'tour', 'spotify', 'streaming'],
        
        // Finance
        'finance': ['money', 'stock', 'investment', 'trading', 'market', 'economy', 'recession', 'inflation', 'bank'],
        'stock': ['market', 'trading', 'investment', 'shares', 'nasdaq', 'dow', 'sp500', 'finance']
      };
  
      // Direct word matching
      for (const [key, words] of Object.entries(synonyms)) {
        if (filterWord.includes(key) || key.includes(filterWord)) {
          return words.some(word => text.includes(word));
        }
      }
  
      // Partial matching for compound words
      const partialMatches = {
        'political': text.match(/\b(politic\w*|govern\w*|election\w*|campaign\w*)\b/i),
        'crypto': text.match(/\b(crypto\w*|bitcoin\w*|blockchain\w*|nft\w*)\b/i),
        'sports': text.match(/\b(sport\w*|game\w*|match\w*|playoff\w*)\b/i),
        'negative': text.match(/\b(hate\w*|angry\w*|terrible\w*|awful\w*)\b/i)
      };
  
      for (const [key, regex] of Object.entries(partialMatches)) {
        if (filterWord.includes(key) && regex) {
          return true;
        }
      }
  
      return false;
    }
  
    applyFilter(tweetElement, reason, confidence, method) {
      // Don't apply filter if already filtered
      if (tweetElement.classList.contains('filtered-content')) return;
  
      tweetElement.classList.add('filtered-content');
      
      // Create overlay
      const overlay = document.createElement('div');
      overlay.className = 'filter-overlay';
      
      // Enhanced overlay with visual filtering info
      const isVisualFilter = method && method.includes('Vision');
      const filterIcon = isVisualFilter ? '🛡️👁️' : '🛡️';
      
      overlay.innerHTML = `
        <div class="filter-message">
          <div class="filter-icon">${filterIcon}</div>
          <div class="filter-text">
            <strong>Content Filtered</strong>
            <p>This post was hidden because it matches: "${reason}"</p>
            <div class="filter-meta">
              <span class="confidence">Confidence: ${confidence || 'N/A'}</span>
              ${method ? `<span class="method">Method: ${method}</span>` : ''}
            </div>
            ${isVisualFilter ? '<div class="vision-note">🖼️ Includes image analysis</div>' : ''}
          </div>
          <button class="show-content-btn">Show Content</button>
        </div>
      `;
  
      // Position overlay
      tweetElement.style.position = 'relative';
      tweetElement.appendChild(overlay);
  
      // Add click handler to show content
      const showButton = overlay.querySelector('.show-content-btn');
      showButton.addEventListener('click', () => {
        overlay.style.display = 'none';
        tweetElement.classList.add('content-revealed');
      });
    }
  }
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      new TwitterContentFilter();
    });
  } else {
    new TwitterContentFilter();
  }