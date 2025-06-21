// Background script for the Chrome extension (Manifest V3)
console.log('Smart Social Filter background script loaded');

// API configuration - using OpenAI GPT-4o mini (fast and cheap)
// const API_URL = 'https://api.openai.com/v1/chat/completions';
// const MODEL_NAME = 'gpt-4o-mini';
// const API_KEY = ''; // Replace with your actual API key


const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';
const MODEL_NAME = 'gemini-1.5-flash-latest';
const API_KEY = ''; // Get from Google AI Studio


chrome.runtime.onInstalled.addListener(() => {
  console.log('Smart Social Filter extension installed');
  
  // Initialize default filters if none exist
  chrome.storage.sync.get(['filters'], (result) => {
    if (!result.filters) {
      chrome.storage.sync.set({ 
        filters: [] 
      });
    }
  });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getFilters') {
    chrome.storage.sync.get(['filters'], (result) => {
      sendResponse({ filters: result.filters || [] });
    });
    return true;
  } else if (message.action === 'checkAPI') {
    // Check if API is configured
    checkAPIStatus().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ available: false, error: error.message });
    });
    return true;
  } else if (message.action === 'filterBatch') {
    // Filter multiple tweets in a single API call
    analyzeBatchWithAPI(message.tweets, message.filters).then(results => {
      sendResponse(results);
    }).catch(error => {
      // Return error result for each tweet in batch
      const errorResults = message.tweets.map(() => ({
        shouldFilter: false,
        error: 'Batch API analysis failed',
        method: 'Batch Error',
        details: error.message
      }));
      sendResponse(errorResults);
    });
    return true;
  } else if (message.action === 'filterContent') {
    // Legacy single tweet filtering (still supported)
    analyzeContentWithAPI(message.text, message.filters).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({
        shouldFilter: false,
        error: 'API analysis failed',
        method: 'Error',
        details: error.message
      });
    });
    return true;
  }
});

async function checkAPIStatus() {
    if (!API_KEY || API_KEY === 'YOUR_GOOGLE_API_KEY') {
      return {
        available: false,
        error: 'API key not configured. Please add your Google AI API key to background.js'
      };
    }
  
    try {
      // Test API with a simple request
      const response = await fetch(`${API_URL}?key=${API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: 'test'
            }]
          }],
          generationConfig: {
            maxOutputTokens: 1,
            temperature: 0.1
          }
        })
      });
  
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`API error: ${error.error?.message || response.status}`);
      }
      
      return {
        available: true,
        model: MODEL_NAME
      };
    } catch (error) {
      return {
        available: false,
        error: `API not accessible: ${error.message}`
      };
    }
  }
  
  async function analyzeBatchWithAPI(tweets, filters) {
    // If no filters, don't filter anything
    if (!filters || filters.length === 0) {
      return tweets.map(() => ({ 
        shouldFilter: false, 
        method: 'No Filters Active',
        reason: 'No filters configured',
        details: 'Add filters to enable content filtering'
      }));
    }
  
    // Create filter list
    const filterList = filters.map((filter, index) => `${index + 1}. ${filter}`).join('\n');
    
    // Create batch prompt with all tweets
    const tweetsList = tweets.map((tweet, index) => 
      `Tweet ${index + 1}: "${tweet.text}"${tweet.hasImages ? ' [Contains images]' : ''}`
    ).join('\n\n');
    
    const prompt = `You are a content moderator for social media. Analyze these ${tweets.length} posts against the filter rules below.
  
  FILTER RULES:
  ${filterList}
  
  POSTS TO ANALYZE:
  ${tweetsList}
  
  Instructions:
  - Analyze EACH tweet against ALL filter rules
  - Consider semantic meaning, euphemisms, context, sarcasm, and intent
  - Look beyond just keywords - understand the real meaning
  - Return results for ALL tweets in the EXACT same order (Tweet 1, Tweet 2, etc.)
  - If multiple rules match for a tweet, choose the most relevant one
  
  Respond with ONLY this JSON format:
  {
    "results": [
      {
        "tweetIndex": 1,
        "shouldFilter": true,
        "matchedFilter": "exact text of matched filter",
        "confidence": 85,
        "reasoning": "brief explanation"
      },
      {
        "tweetIndex": 2,
        "shouldFilter": false,
        "matchedFilter": null,
        "confidence": 10,
        "reasoning": "brief explanation"
      }
    ]
  }`;
  
    try {
      const response = await fetch(`${API_URL}?key=${API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            maxOutputTokens: 300 + (tweets.length * 100), // Scale tokens with number of tweets
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      });
  
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`API error: ${error.error?.message || response.status}`);
      }
  
      const result = await response.json();
      const responseText = result.candidates[0].content.parts[0].text.trim();
      
      console.log('Batch Gemini API response:', responseText);
      
      // Parse JSON response
      try {
        const parsed = JSON.parse(responseText);
        const apiResults = parsed.results || [];
        
        // Ensure we have results for all tweets
        const processedResults = tweets.map((tweet, index) => {
          const apiResult = apiResults.find(r => r.tweetIndex === (index + 1)) || 
                           apiResults[index] || 
                           { shouldFilter: false, confidence: 0, reasoning: 'No result returned' };
          
          return {
            shouldFilter: apiResult.shouldFilter || false,
            confidence: `${Math.min(100, Math.max(1, apiResult.confidence || 50))}%`,
            method: `${MODEL_NAME} Batch API`,
            reason: apiResult.matchedFilter || 'No filter matched',
            details: apiResult.reasoning || 'Batch analysis completed'
          };
        });
        
        return processedResults;
        
      } catch (parseError) {
        console.log('Batch JSON parse failed:', parseError);
        
        // Return fallback results for all tweets
        return tweets.map(() => ({
          shouldFilter: false,
          confidence: '0%',
          method: `${MODEL_NAME} Batch API - Parse Error`,
          reason: 'JSON parsing failed',
          details: 'API returned invalid JSON format'
        }));
      }
    } catch (error) {
      console.error('Batch API error:', error);
      throw error;
    }
  }
  
  // Legacy single tweet filtering (if needed)
  async function analyzeContentWithAPI(text, filters) {
    const filterList = filters.join(', ');
    
    const prompt = `Analyze this social media post against these filter rules: ${filterList}
  
  Post: "${text}"
  
  Should this be filtered? Consider semantic meaning and context, not just keywords.
  
  Respond with JSON: {"shouldFilter": true/false, "matchedFilter": "rule name or null", "confidence": 1-100, "reasoning": "brief explanation"}`;
  
    try {
      const response = await fetch(`${API_URL}?key=${API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            maxOutputTokens: 200,
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      });
  
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`API error: ${error.error?.message || response.status}`);
      }
  
      const result = await response.json();
      const responseText = result.candidates[0].content.parts[0].text.trim();
      
      const parsed = JSON.parse(responseText);
      
      return {
        shouldFilter: parsed.shouldFilter || false,
        confidence: `${parsed.confidence || 50}%`,
        method: `${MODEL_NAME} API`,
        reason: parsed.matchedFilter || 'No filter matched',
        details: parsed.reasoning || 'Analysis completed'
      };
      
    } catch (error) {
      console.error('Single API error:', error);
      return {
        shouldFilter: false,
        error: 'API analysis failed',
        method: 'Error',
        details: error.message
      };
    }
  }