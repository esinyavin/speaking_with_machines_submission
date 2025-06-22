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
      // Initialize Model
      await this.initializeModel();
      
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
  
    async initializeModel() {
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