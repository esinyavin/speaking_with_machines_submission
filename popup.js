document.addEventListener('DOMContentLoaded', function() {
    const filterInput = document.getElementById('filterInput');
    const saveButton = document.getElementById('saveFilter');
    const clearButton = document.getElementById('clearFilters');
    const status = document.getElementById('status');
    const filterList = document.getElementById('filterList');
    const aiStatus = document.getElementById('aiStatus');
  
    // Load existing filters and check AI status
    loadFilters();
    checkAIStatus();
  
    saveButton.addEventListener('click', saveFilter);
    clearButton.addEventListener('click', clearAllFilters);
  
    async function checkAIStatus() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && (tab.url.includes('twitter.com') || tab.url.includes('x.com'))) {
          // Send message to content script and wait for response
          chrome.tabs.sendMessage(tab.id, { action: 'getAIStatus' }, (response) => {
            if (chrome.runtime.lastError) {
              // Content script not ready or failed
              aiStatus.className = 'ai-status unavailable';
              aiStatus.querySelector('.status-text').textContent = '❌ Content script not loaded';
              return;
            }
            
            if (response && response.aiAvailable) {
              aiStatus.className = 'ai-status available';
              aiStatus.querySelector('.status-text').textContent = '🤖 API Filtering Active';
            } else if (response && response.isLoading) {
              aiStatus.className = 'ai-status unavailable';
              aiStatus.querySelector('.status-text').textContent = '⏳ Connecting to API...';
            } else {
              aiStatus.className = 'ai-status unavailable';
              aiStatus.querySelector('.status-text').textContent = '❌ API Key Required';
            }
          });
        } else {
          aiStatus.className = 'ai-status unavailable';
          aiStatus.querySelector('.status-text').textContent = '💡 Visit Twitter/X to activate';
        }
      } catch (error) {
        console.error('Error checking AI status:', error);
        aiStatus.className = 'ai-status unavailable';
        aiStatus.querySelector('.status-text').textContent = '❌ Status Check Failed';
      }
    }
  
    async function saveFilter() {
      const filterText = filterInput.value.trim();
      if (!filterText) {
        showStatus('Please enter a filter description', 'error');
        return;
      }
  
      try {
        const result = await chrome.storage.sync.get(['filters']);
        const filters = result.filters || [];
        
        if (!filters.includes(filterText)) {
          filters.push(filterText);
          await chrome.storage.sync.set({ filters });
          filterInput.value = '';
          showStatus('Filter added successfully!', 'success');
          loadFilters();
          
          // Notify content script to update filters
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && (tab.url.includes('twitter.com') || tab.url.includes('x.com'))) {
            chrome.tabs.sendMessage(tab.id, { action: 'updateFilters', filters });
          }
        } else {
          showStatus('Filter already exists', 'error');
        }
      } catch (error) {
        showStatus('Error saving filter', 'error');
        console.error(error);
      }
    }
  
    async function clearAllFilters() {
      try {
        await chrome.storage.sync.set({ filters: [] });
        showStatus('All filters cleared', 'success');
        loadFilters();
        
        // Notify content script
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && (tab.url.includes('twitter.com') || tab.url.includes('x.com'))) {
          chrome.tabs.sendMessage(tab.id, { action: 'updateFilters', filters: [] });
        }
      } catch (error) {
        showStatus('Error clearing filters', 'error');
        console.error(error);
      }
    }
  
    async function loadFilters() {
      try {
        const result = await chrome.storage.sync.get(['filters']);
        const filters = result.filters || [];
        
        filterList.innerHTML = '';
        if (filters.length === 0) {
          filterList.innerHTML = '<div style="color: #657786; font-style: italic;">No filters active</div>';
        } else {
          filters.forEach(filter => {
            const filterDiv = document.createElement('div');
            filterDiv.className = 'filter-item';
            filterDiv.textContent = filter;
            filterList.appendChild(filterDiv);
          });
        }
      } catch (error) {
        console.error('Error loading filters:', error);
      }
    }
  
    function showStatus(message, type) {
      status.textContent = message;
      status.className = `status ${type}`;
      status.style.display = 'block';
      setTimeout(() => {
        status.style.display = 'none';
      }, 3000);
    }
  });
      