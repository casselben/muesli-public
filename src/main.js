const { app, BrowserWindow, ipcMain, protocol, Notification } = require('electron');
const path = require('node:path');
const url = require('url');
const fs = require('fs');
const RecallAiSdk = require('@recallai/desktop-sdk');
const axios = require('axios');
const OpenAI = require('openai');
const sdkLogger = require('./sdk-logger');
require('dotenv').config();

// Function to get the OpenRouter headers
function getHeaderLines() {
  return [
    "HTTP-Referer: https://recall.ai", // Replace with your actual app's URL
    "X-Title: Muesli AI Notetaker"
  ];
}

// Initialize OpenAI client with OpenRouter as the base URL
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://recall.ai",
    "X-Title": "Muesli AI Notetaker"
  }
});

// Define available models with their capabilities
const MODELS = {
  // Primary models
  PRIMARY: "anthropic/claude-3.7-sonnet",
  FALLBACKS: []
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Store detected meeting information
let detectedMeeting = null;

let mainWindow;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f9f9f9',
  });

  // Allow the debug panel header to act as a drag region
  mainWindow.on('ready-to-show', () => {
    try {
      // Set regions that can be used to drag the window
      if (process.platform === 'darwin') {
        // Only needed on macOS
        mainWindow.setWindowButtonVisibility(true);
      }
    } catch (error) {
      console.error('Error setting drag regions:', error);
    }
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools in development
  if (process.env.NODE_ENV === 'development') {
    // mainWindow.webContents.openDevTools();
  }
};

// Listen for navigation events (registered once, outside createWindow)
ipcMain.on('navigate', (event, page) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (page === 'note-editor') {
    mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY + '/../note-editor/index.html');
  } else if (page === 'home') {
    mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  }
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  console.log("Registering IPC handlers...");
  // Log all registered IPC handlers
  console.log("IPC handlers:", Object.keys(ipcMain._invokeHandlers));

  // Set up SDK logger IPC handlers
  ipcMain.on('sdk-log', (event, logEntry) => {
    // Forward logs from renderer to any open windows
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-log', logEntry);
    }
  });

  // Set up logger event listener to send logs from main to renderer
  sdkLogger.onLog((logEntry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-log', logEntry);
    }
  });

  // Create meetings file if it doesn't exist
  try {
    if (!fs.existsSync(meetingsFilePath)) {
      const initialData = { upcomingMeetings: [], pastMeetings: [] };
      fs.writeFileSync(meetingsFilePath, JSON.stringify(initialData, null, 2));
    }
  } catch (e) {
    console.error("Couldn't create the meetings file:", e);
  }

  // Initialize the Recall.ai SDK
  initSDK();

  createWindow();

  // When the window is ready, send the initial meeting detection status
  mainWindow.webContents.on('did-finish-load', () => {
    // Send the initial meeting detection status
    mainWindow.webContents.send('meeting-detection-status', { detected: detectedMeeting !== null });
  });

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up SDK resources and active recordings before quitting
app.on('before-quit', async () => {
  console.log('App quitting, cleaning up...');
  try {
    // Stop any active recordings
    const allRecordings = activeRecordings.getAll();
    for (const [recordingId, info] of Object.entries(allRecordings)) {
      try {
        console.log(`Stopping active recording ${recordingId} before quit`);
        await RecallAiSdk.stopRecording({ windowId: recordingId });
      } catch (err) {
        console.error(`Error stopping recording ${recordingId} on quit:`, err);
      }
    }
  } catch (error) {
    console.error('Error during cleanup on quit:', error);
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

// Path to meetings data file in the user's Application Support directory
const meetingsFilePath = path.join(app.getPath('userData'), 'meetings.json');

// Global state to track active recordings
const activeRecordings = {
  // Map of recordingId -> {noteId, platform, state}
  recordings: {},

  // Register a new recording
  addRecording: function (recordingId, noteId, platform = 'unknown') {
    this.recordings[recordingId] = {
      noteId,
      platform,
      state: 'recording',
      startTime: new Date()
    };
    console.log(`Recording registered in global state: ${recordingId} for note ${noteId}`);
  },

  // Update a recording's state
  updateState: function (recordingId, state) {
    if (this.recordings[recordingId]) {
      this.recordings[recordingId].state = state;
      console.log(`Recording ${recordingId} state updated to: ${state}`);
      return true;
    }
    return false;
  },

  // Remove a recording
  removeRecording: function (recordingId) {
    if (this.recordings[recordingId]) {
      delete this.recordings[recordingId];
      console.log(`Recording ${recordingId} removed from global state`);
      return true;
    }
    return false;
  },

  // Get active recording for a note
  getForNote: function (noteId) {
    for (const [recordingId, info] of Object.entries(this.recordings)) {
      if (info.noteId === noteId) {
        return { recordingId, ...info };
      }
    }
    return null;
  },

  // Get all active recordings
  getAll: function () {
    return { ...this.recordings };
  }
};

// File operation manager to prevent race conditions on both reads and writes
const fileOperationManager = {
  isProcessing: false,
  pendingOperations: [],
  cachedData: null,
  lastReadTime: 0,

  // Read the meetings data with caching to reduce file I/O
  readMeetingsData: async function () {
    // If we have cached data that's recent (less than 500ms old), use it
    const now = Date.now();
    if (this.cachedData && (now - this.lastReadTime < 500)) {
      return JSON.parse(JSON.stringify(this.cachedData)); // Deep clone
    }

    try {
      // Read from file
      const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      const data = JSON.parse(fileData);

      // Store a deep clone in cache so callers can't mutate it
      this.cachedData = JSON.parse(JSON.stringify(data));
      this.lastReadTime = now;

      return data;
    } catch (error) {
      console.error('Error reading meetings data:', error);
      // If file doesn't exist or is invalid, return empty structure
      return { upcomingMeetings: [], pastMeetings: [] };
    }
  },

  // Schedule an operation that needs to update the meetings data
  scheduleOperation: async function (operationFn) {
    return new Promise((resolve, reject) => {
      // Add this operation to the queue
      this.pendingOperations.push({
        operationFn, // This function will receive the current data and return updated data
        resolve,
        reject
      });

      // Process the queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  },

  // Process the operation queue sequentially
  processQueue: async function () {
    if (this.pendingOperations.length === 0 || this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    let nextOp = null;
    try {
      // Get the next operation
      nextOp = this.pendingOperations.shift();

      // Read the latest data
      const currentData = await this.readMeetingsData();

      // Execute the operation function with the current data
      const updatedData = await nextOp.operationFn(currentData);

      // If the operation returned data, write it
      if (updatedData) {
        // Update cache immediately
        this.cachedData = JSON.parse(JSON.stringify(updatedData));
        this.lastReadTime = Date.now();

        // Write to file
        await fs.promises.writeFile(meetingsFilePath, JSON.stringify(updatedData, null, 2));
      }

      // Resolve the operation's promise
      nextOp.resolve({ success: true });
    } catch (error) {
      console.error('Error in file operation manager:', error);

      // Reject the correct operation's promise
      if (nextOp) {
        nextOp.reject(error);
      }
    } finally {
      this.isProcessing = false;

      // Check if more operations were added while we were processing
      if (this.pendingOperations.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  },

  // Helper to write data directly - internally uses scheduleOperation
  writeData: async function (data) {
    return this.scheduleOperation(() => data); // Simply return the data to write
  }
};

// Create a desktop SDK upload token (tries ports 13373–13382 to match server fallback)
async function createDesktopSdkUpload() {
  const PORT_MIN = 13373;
  const PORT_MAX = 13382;
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    try {
      const response = await axios.get(`http://localhost:${port}/start-recording`, { timeout: 10000 });
      if (response.data.status !== 'success') {
        console.error("Failed to create upload token:", response.data.message);
        return null;
      }
      console.log("Upload token created successfully:", response.data.upload_token);
      return response.data;
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.response?.status === 404) {
        continue;
      }
      console.error("Error creating upload token:", JSON.stringify(error.errors || error.message || error));
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
      }
      return null;
    }
  }
  console.error("Could not reach start-recording server on ports 13373–13382");
  return null;
}

// Initialize the Recall.ai SDK
function initSDK() {
  console.log("Initializing Recall.ai SDK");

  // Log the SDK initialization
  sdkLogger.logApiCall('init', {
    dev: process.env.NODE_ENV === 'development',
    api_url: process.env.RECALLAI_API_URL
  });

  RecallAiSdk.init({
    // dev: true,
    api_url: process.env.RECALLAI_API_URL
  });

  // Listen for meeting detected events
  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    console.log("Meeting detected:", evt);

    if (!evt.window || evt.window.id == null) {
      console.warn('Meeting detected event missing window or window.id, skipping');
      return;
    }

    sdkLogger.logEvent('meeting-detected', {
      platform: evt.window.platform,
      windowId: evt.window.id
    });

    detectedMeeting = evt;

    // Map platform codes to readable names
    const platformNames = {
      'zoom': 'Zoom',
      'google-meet': 'Google Meet',
      'slack': 'Slack',
      'teams': 'Microsoft Teams'
    };

    // Get a user-friendly platform name, or use the raw platform name if not in our map
    const platformName = platformNames[evt.window.platform] || evt.window.platform;

    // Send a notification
    let notification = new Notification({
      title: `${platformName} Meeting Detected`,
      body: platformName
    });

    // Handle notification click
    notification.on('click', () => {
      console.log("Notification clicked for platform:", platformName);
      joinDetectedMeeting();
    });

    notification.show();

    // Send the meeting detected status to the renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-detection-status', { detected: true });
    }
  });

  // Listen for meeting updated events (to capture title and URL)
  // NOTE: meeting-detected events do NOT guarantee title and URL will be populated.
  // The meeting title and URL are only reliably available in meeting-updated events,
  // which fire as the meeting metadata becomes available after initial detection.
  RecallAiSdk.addEventListener('meeting-updated', async (evt) => {
    console.log("Meeting updated:", evt);

    const { window } = evt;

    if (!window || window.id == null) {
      console.warn('Meeting updated event missing window or window.id, skipping');
      return;
    }

    sdkLogger.logEvent('meeting-updated', {
      platform: window.platform,
      windowId: window.id,
      title: window.title,
      url: window.url
    });

    if (detectedMeeting && detectedMeeting.window && detectedMeeting.window.id === window.id) {
      detectedMeeting = {
        ...detectedMeeting,
        window: {
          ...detectedMeeting.window,
          title: window.title,
          url: window.url
        }
      };

      console.log("Updated meeting title:", window.title);

      // If a note has already been created for this meeting, update its title retroactively
      if (window.title && global.activeMeetingIds && global.activeMeetingIds[window.id]) {
        const noteId = global.activeMeetingIds[window.id].noteId;
        
        if (noteId) {
          console.log("Updating existing note title for:", noteId);
          
          try {
            await fileOperationManager.scheduleOperation((meetingsData) => {
              const meeting = meetingsData.pastMeetings.find(m => m.id === noteId);
              if (meeting) {
                const oldTitle = meeting.title;
                meeting.title = window.title;
                console.log(`Successfully updated meeting title from "${oldTitle}" to "${window.title}"`);
              } else {
                console.error("Meeting not found in pastMeetings with ID:", noteId);
              }
              return meetingsData;
            });
              
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('meeting-title-updated', {
                meetingId: noteId,
                newTitle: window.title
              });
            }
          } catch (error) {
            console.error("Error updating meeting title:", error);
          }
        }
      }
    }
  });

  // Listen for meeting closed events
  RecallAiSdk.addEventListener('meeting-closed', (evt) => {
    console.log("Meeting closed:", evt);

    if (!evt.window || evt.window.id == null) {
      console.warn('Meeting closed event missing window or window.id, skipping');
      return;
    }

    // Log the SDK meeting-closed event
    sdkLogger.logEvent('meeting-closed', {
      windowId: evt.window.id
    });

    // Clean up the global tracking when a meeting ends
    if (global.activeMeetingIds && global.activeMeetingIds[evt.window.id]) {
      console.log(`Cleaning up meeting tracking for: ${evt.window.id}`);
      delete global.activeMeetingIds[evt.window.id];
    }

    // Only clear detectedMeeting if this is the one we're tracking
    if (detectedMeeting && detectedMeeting.window && detectedMeeting.window.id === evt.window.id) {
      detectedMeeting = null;
    }

    // Send the meeting closed status to the renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-detection-status', { detected: false });
    }
  });

  // Listen for recording ended events
  RecallAiSdk.addEventListener('recording-ended', async (evt) => {
    console.log("Recording ended:", evt);

    if (!evt.window || evt.window.id == null) {
      console.warn('Recording ended event missing window or window.id (e.g. meeting closed first), skipping');
      return;
    }

    const windowId = evt.window.id;

    // Log the SDK recording-ended event
    sdkLogger.logEvent('recording-ended', {
      windowId
    });

    try {
      // Update the note with recording information
      await updateNoteWithRecordingInfo(windowId);

      // Add a small delay before uploading (good practice for file system operations)
      setTimeout(async () => {
        try {
          // Try to get a new upload token for the upload if needed
          const uploadData = await createDesktopSdkUpload();

          if (uploadData && uploadData.upload_token) {
            console.log('Uploading recording with new upload token:', uploadData.upload_token);

            // Log the uploadRecording API call
            sdkLogger.logApiCall('uploadRecording', {
              windowId,
              uploadToken: `${uploadData.upload_token.substring(0, 8)}...` // Log truncated token for security
            });

            await RecallAiSdk.uploadRecording({
              windowId,
              uploadToken: uploadData.upload_token
            });
          } else {
            // Fallback to regular upload
            console.log('Uploading recording without new token');

            // Log the uploadRecording API call (fallback)
            sdkLogger.logApiCall('uploadRecording', {
              windowId
            });

            await RecallAiSdk.uploadRecording({ windowId });
          }
        } catch (uploadError) {
          console.error('Error during upload:', uploadError);
          // Fallback to regular upload (use captured windowId, not evt.window)
          sdkLogger.logApiCall('uploadRecording', {
            windowId,
            error: 'Fallback after error'
          });
          try {
            await RecallAiSdk.uploadRecording({ windowId });
          } catch (fallbackError) {
            console.error('Fallback upload also failed (window may be closed):', fallbackError);
          }
        }
      }, 3000); // Wait 3 seconds before uploading
    } catch (error) {
      console.error("Error handling recording ended:", error);
    }
  });

  RecallAiSdk.addEventListener('permissions-granted', async (evt) => {
    console.log("PERMISSIONS GRANTED");
  });

  // Track upload progress
  RecallAiSdk.addEventListener('upload-progress', async (evt) => {
    const { progress, window } = evt;
    console.log(`Upload progress: ${progress}%`);

    // Guard: window may be missing if meeting was closed before upload completed
    if (progress === 100 && window && window.id != null) {
      console.log(`Upload completed for recording: ${window.id}`);
      // Could update the note here with upload completion status
    }
  });

  // Track SDK state changes
  RecallAiSdk.addEventListener('sdk-state-change', async (evt) => {
    const code = evt.sdk?.state?.code;
    const window = evt.window;

    if (code == null) {
      console.warn('SDK state change event missing state code, skipping');
      return;
    }

    console.log("Recording state changed:", code, "for window:", window?.id);

    // Log the SDK sdk-state-change event
    sdkLogger.logEvent('sdk-state-change', {
      state: code,
      windowId: window?.id
    });

    // Update recording state in our global tracker
    if (window && window.id != null) {
      // Get the meeting note ID associated with this window
      let noteId = null;
      if (global.activeMeetingIds && global.activeMeetingIds[window.id]) {
        noteId = global.activeMeetingIds[window.id].noteId;
      }

      // Update the recording state in our tracker
      if (code === 'recording') {
        console.log('Recording in progress...');
        if (noteId) {
          // If recording started, add it to our active recordings
          activeRecordings.addRecording(window.id, noteId, window.platform || 'unknown');
        }
      } else if (code === 'paused') {
        console.log('Recording paused');
        activeRecordings.updateState(window.id, 'paused');
      } else if (code === 'idle') {
        console.log('Recording stopped');
        activeRecordings.removeRecording(window.id);
      }

      // Notify renderer process about recording state change
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-state-change', {
          recordingId: window.id,
          state: code,
          noteId
        });
      }
    }
  });

  // Listen for real-time transcript events
  RecallAiSdk.addEventListener('realtime-event', async (evt) => {
    // Only log non-video frame events to prevent flooding the logger
    if (evt.event !== 'video_separate_png.data') {
      console.log("Received realtime event:", evt.event);

      // Log the SDK realtime-event event
      sdkLogger.logEvent('realtime-event', {
        eventType: evt.event,
        windowId: evt.window?.id
      });
    }

    // Handle different event types
    if (evt.event === 'transcript.data' && evt.data && evt.data.data) {
      await processTranscriptData(evt);
    }
    else if (evt.event === 'transcript.provider_data' && evt.data && evt.data.data) {
      await processTranscriptProviderData(evt);
    }
    else if (evt.event === 'participant_events.join' && evt.data && evt.data.data) {
      await processParticipantJoin(evt);
    }
    else if (evt.event === 'video_separate_png.data' && evt.data && evt.data.data) {
      await processVideoFrame(evt);
    }
  });

  // Handle errors
  RecallAiSdk.addEventListener('error', async (evt) => {
    console.error("RecallAI SDK Error:", evt);
    const { type, message } = evt;

    // Log the SDK error event
    sdkLogger.logEvent('error', {
      errorType: type,
      errorMessage: message
    });

    // Show notification for errors
    let notification = new Notification({
      title: 'Recording Error',
      body: `Error: ${type} - ${message}`
    });
    notification.show();
  });
}

// Handle saving meetings data
ipcMain.handle('saveMeetingsData', async (event, data) => {
  try {
    // Use the file operation manager to safely write the file
    await fileOperationManager.writeData(data);
    return { success: true };
  } catch (error) {
    console.error('Failed to save meetings data:', error);
    return { success: false, error: error.message };
  }
});

// Debug handler to check if IPC handlers are registered
ipcMain.handle('debugGetHandlers', async () => {
  console.log("Checking registered IPC handlers...");
  const handlers = Object.keys(ipcMain._invokeHandlers);
  console.log("Registered handlers:", handlers);
  return handlers;
});

// Handler to get active recording ID for a note
ipcMain.handle('getActiveRecordingId', async (event, noteId) => {
  console.log(`getActiveRecordingId called for note: ${noteId}`);

  try {
    // If noteId is provided, get recording for that specific note
    if (noteId) {
      const recordingInfo = activeRecordings.getForNote(noteId);
      return {
        success: true,
        data: recordingInfo
      };
    }

    // Otherwise return all active recordings
    return {
      success: true,
      data: activeRecordings.getAll()
    };
  } catch (error) {
    console.error('Error getting active recording ID:', error);
    return { success: false, error: error.message };
  }
});

// Handle deleting a meeting
ipcMain.handle('deleteMeeting', async (event, meetingId) => {
  try {
    console.log(`Deleting meeting with ID: ${meetingId}`);

    let recordingId = null;
    let meetingDeleted = false;

    await fileOperationManager.scheduleOperation((meetingsData) => {
      const pastMeetingIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === meetingId);
      const upcomingMeetingIndex = meetingsData.upcomingMeetings.findIndex(meeting => meeting.id === meetingId);

      if (pastMeetingIndex !== -1) {
        recordingId = meetingsData.pastMeetings[pastMeetingIndex].recordingId;
        meetingsData.pastMeetings.splice(pastMeetingIndex, 1);
        meetingDeleted = true;
      }

      if (upcomingMeetingIndex !== -1) {
        recordingId = meetingsData.upcomingMeetings[upcomingMeetingIndex].recordingId;
        meetingsData.upcomingMeetings.splice(upcomingMeetingIndex, 1);
        meetingDeleted = true;
      }

      return meetingDeleted ? meetingsData : null;
    });

    if (!meetingDeleted) {
      return { success: false, error: 'Meeting not found' };
    }

    // If the meeting had a recording, cleanup the reference in the global tracking
    if (recordingId && global.activeMeetingIds && global.activeMeetingIds[recordingId]) {
      console.log(`Cleaning up tracking for deleted meeting with recording ID: ${recordingId}`);
      delete global.activeMeetingIds[recordingId];
    }

    console.log(`Successfully deleted meeting: ${meetingId}`);
    return { success: true };
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return { success: false, error: error.message };
  }
});

// Handle generating AI summary for a meeting (non-streaming)
ipcMain.handle('generateMeetingSummary', async (event, meetingId) => {
  try {
    console.log(`Manual summary generation requested for meeting: ${meetingId}`);

    // Read meeting data atomically through the queue
    const meetingsData = await fileOperationManager.readMeetingsData();

    const meeting = meetingsData.pastMeetings.find(m => m.id === meetingId);

    if (!meeting) {
      return { success: false, error: 'Meeting not found' };
    }

    if (!meeting.transcript || meeting.transcript.length === 0) {
      return { success: false, error: 'No transcript available for this meeting' };
    }

    console.log('Generating AI summary for meeting: ' + meetingId);

    let summary;
    try {
      summary = await generateMeetingSummary(meeting);
    } catch (summaryError) {
      console.error('AI summary generation failed:', summaryError);
      return { success: false, error: summaryError.message || 'Summary generation failed' };
    }

    const meetingTitle = meeting.title || "Meeting Notes";

    // Atomically update just the fields we need via scheduleOperation
    await fileOperationManager.scheduleOperation((currentData) => {
      const m = currentData.pastMeetings.find(m => m.id === meetingId);
      if (m) {
        m.content = `# ${meetingTitle}\n\n${summary}`;
        m.hasSummary = true;
      }
      return currentData;
    });

    console.log('Updated meeting note with AI summary');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-generated', meetingId);
    }

    return { success: true, summary };
  } catch (error) {
    console.error('Error generating meeting summary:', error);
    return { success: false, error: error.message };
  }
});

// Handle starting a manual desktop recording
ipcMain.handle('startManualRecording', async (event, meetingId) => {
  try {
    console.log(`Starting manual desktop recording for meeting: ${meetingId}`);

    // Verify the meeting exists
    const meetingsData = await fileOperationManager.readMeetingsData();
    const meeting = meetingsData.pastMeetings.find(m => m.id === meetingId);

    if (!meeting) {
      return { success: false, error: 'Meeting not found' };
    }

    try {
      sdkLogger.logApiCall('prepareDesktopAudioRecording');

      const key = await RecallAiSdk.prepareDesktopAudioRecording();
      console.log('Prepared desktop audio recording with key:', key);

      const uploadData = await createDesktopSdkUpload();
      if (!uploadData || !uploadData.upload_token) {
        return { success: false, error: 'Failed to create recording token' };
      }

      // Store tracking info for the recording
      global.activeMeetingIds = global.activeMeetingIds || {};
      global.activeMeetingIds[key] = {
        platformName: 'Desktop Recording',
        noteId: meetingId
      };

      activeRecordings.addRecording(key, meetingId, 'Desktop Recording');

      // Atomically update the meeting with recording info
      await fileOperationManager.scheduleOperation((currentData) => {
        const m = currentData.pastMeetings.find(m => m.id === meetingId);
        if (m) {
          m.recordingId = key;
          if (!m.transcript) {
            m.transcript = [];
          }
        }
        return currentData;
      });

      console.log('Starting desktop recording with key:', key);

      sdkLogger.logApiCall('startRecording', {
        windowId: key,
        uploadToken: `${uploadData.upload_token.substring(0, 8)}...`
      });

      await RecallAiSdk.startRecording({
        windowId: key,
        uploadToken: uploadData.upload_token
      });

      return { success: true, recordingId: key };
    } catch (sdkError) {
      console.error('RecallAI SDK error:', sdkError);
      return { success: false, error: 'Failed to prepare desktop recording: ' + sdkError.message };
    }
  } catch (error) {
    console.error('Error starting manual recording:', error);
    return { success: false, error: error.message };
  }
});

// Handle stopping a manual desktop recording
ipcMain.handle('stopManualRecording', async (event, recordingId) => {
  try {
    console.log(`Stopping manual desktop recording: ${recordingId}`);

    // Stop the recording - using the windowId property as shown in the reference

    // Log the stopRecording API call
    sdkLogger.logApiCall('stopRecording', {
      windowId: recordingId
    });

    // Update our active recordings tracker
    activeRecordings.updateState(recordingId, 'stopping');

    await RecallAiSdk.stopRecording({
      windowId: recordingId
    });

    // The recording-ended event will be triggered automatically,
    // which will handle uploading and generating the summary

    return { success: true };
  } catch (error) {
    console.error('Error stopping manual recording:', error);
    return { success: false, error: error.message };
  }
});

// Handle generating AI summary with streaming
ipcMain.handle('generateMeetingSummaryStreaming', async (event, meetingId) => {
  try {
    console.log(`Streaming summary generation requested for meeting: ${meetingId}`);

    // Read meeting data atomically
    const meetingsData = await fileOperationManager.readMeetingsData();
    const meeting = meetingsData.pastMeetings.find(m => m.id === meetingId);

    if (!meeting) {
      return { success: false, error: 'Meeting not found' };
    }

    if (!meeting.transcript || meeting.transcript.length === 0) {
      return { success: false, error: 'No transcript available for this meeting' };
    }

    console.log('Generating streaming summary for meeting: ' + meetingId);

    const meetingTitle = meeting.title || "Meeting Notes";

    // Update the note on the frontend right away
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-update', {
        meetingId,
        content: `# ${meetingTitle}\n\nGenerating summary...`
      });
    }

    // Create progress callback for streaming updates
    const streamProgress = (currentText) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('summary-update', {
            meetingId,
            content: `# ${meetingTitle}\n\n## AI-Generated Meeting Summary\n${currentText}`,
            timestamp: Date.now()
          });
        } catch (err) {
          console.error('Error sending streaming update to renderer:', err);
        }
      }
    };

    let summary;
    try {
      summary = await generateMeetingSummary(meeting, streamProgress);
    } catch (summaryError) {
      console.error('Streaming AI summary generation failed:', summaryError);
      return { success: false, error: summaryError.message || 'Summary generation failed' };
    }

    // Atomically save the final summary without overwriting concurrent transcript writes
    await fileOperationManager.scheduleOperation((currentData) => {
      const m = currentData.pastMeetings.find(m => m.id === meetingId);
      if (m) {
        m.content = `# ${meetingTitle}\n\n${summary}`;
        m.hasSummary = true;
      }
      return currentData;
    });

    console.log('Updated meeting note with AI summary (streaming)');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-generated', meetingId);
    }

    return { success: true, summary };
  } catch (error) {
    console.error('Error generating streaming summary:', error);
    return { success: false, error: error.message };
  }
});

// Return the OpenRouter key to the renderer (for client-side extraction)
ipcMain.handle('getOpenRouterKey', async () => {
  return process.env.OPENROUTER_KEY || '';
});

const { pushAllTasksToAsana } = require('./asana-push');

ipcMain.handle('pushTasksToAsana', async (event, tasks) => {
  try {
    return await pushAllTasksToAsana(tasks);
  } catch (err) {
    console.error('pushTasksToAsana error:', err);
    return { succeeded: 0, failed: (tasks || []).length, results: [], error: err.message };
  }
});

// Handle loading meetings data
ipcMain.handle('loadMeetingsData', async () => {
  try {
    // Use our file operation manager to safely read the data
    const data = await fileOperationManager.readMeetingsData();

    // Return the data
    return {
      success: true,
      data: data
    };
  } catch (error) {
    console.error('Failed to load meetings data:', error);
    return { success: false, error: error.message };
  }
});

// Function to create a new meeting note and start recording
async function createMeetingNoteAndRecord(platformName) {
  console.log("Creating meeting note for platform:", platformName);
  try {
    if (!detectedMeeting || !detectedMeeting.window) {
      console.error('No active meeting detected');
      return null;
    }

    // Capture the window ID immediately so it survives across await boundaries
    // (meeting-closed can set detectedMeeting = null at any time)
    const meetingWindowId = detectedMeeting.window.id;
    const meetingWindowTitle = detectedMeeting.window.title;
    const meetingWindowPlatform = detectedMeeting.window.platform;

    console.log("Detected meeting info:", meetingWindowId, meetingWindowPlatform);

    global.activeMeetingIds = global.activeMeetingIds || {};
    global.activeMeetingIds[meetingWindowId] = { platformName };

    const id = 'meeting-' + Date.now();
    const now = new Date();

    const meetingTitle = meetingWindowTitle 
      ? meetingWindowTitle 
      : `${platformName} Meeting - ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    const template = `# ${meetingTitle}\nRecording: In Progress...`;

    const newMeeting = {
      id: id,
      type: 'document',
      title: meetingTitle,
      subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      hasDemo: false,
      date: now.toISOString(),
      participants: [],
      content: template,
      recordingId: meetingWindowId,
      platform: platformName,
      transcript: []
    };

    if (global.activeMeetingIds[meetingWindowId]) {
      global.activeMeetingIds[meetingWindowId].noteId = id;
    }

    activeRecordings.addRecording(meetingWindowId, id, platformName);

    // Atomically add the meeting to the data file
    console.log(`Saving meeting data with ID: ${id}`);
    await fileOperationManager.scheduleOperation((currentData) => {
      currentData.pastMeetings.unshift(newMeeting);
      return currentData;
    });

    console.log(`Successfully saved meeting ${id}`);

    // Tell the renderer to open the new note
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        console.log(`Sending IPC message to open meeting note: ${id}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('open-meeting-note', id);
        }

        // Send another message after 2 seconds as a backup
        setTimeout(() => {
          console.log(`Sending backup IPC message to open meeting note: ${id}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('open-meeting-note', id);
          }
        }, 2000);
      }, 1500);
    }

    // Start recording with upload token (using captured meetingWindowId)
    console.log('Starting recording for meeting:', meetingWindowId);

    try {
      const uploadData = await createDesktopSdkUpload();

      if (!uploadData || !uploadData.upload_token) {
        console.error('Failed to get upload token. Recording without upload token.');
        sdkLogger.logApiCall('startRecording', { windowId: meetingWindowId });
        await RecallAiSdk.startRecording({ windowId: meetingWindowId });
      } else {
        console.log('Starting recording with upload token:', uploadData.upload_token);
        sdkLogger.logApiCall('startRecording', {
          windowId: meetingWindowId,
          uploadToken: `${uploadData.upload_token.substring(0, 8)}...`
        });
        await RecallAiSdk.startRecording({
          windowId: meetingWindowId,
          uploadToken: uploadData.upload_token
        });
      }
    } catch (error) {
      console.error('Error starting recording with upload token:', error);
      sdkLogger.logApiCall('startRecording', {
        windowId: meetingWindowId,
        error: 'Fallback after error'
      });
      try {
        await RecallAiSdk.startRecording({ windowId: meetingWindowId });
      } catch (fallbackError) {
        console.error('Fallback recording start also failed:', fallbackError);
      }
    }

    return id;
  } catch (error) {
    console.error('Error creating meeting note:', error);
    return null;
  }
}

// Function to process video frames
async function processVideoFrame(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in video frame event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the video data
    const frameData = evt.data.data;
    if (!frameData || !frameData.buffer) {
      console.log("No video frame data in event");
      return;
    }

    // Get data from the event
    const frameBuffer = frameData.buffer; // base64 encoded PNG
    const frameTimestamp = frameData.timestamp;
    const frameType = frameData.type; // 'webcam' or 'screenshare'
    const participantData = frameData.participant;

    // Extract participant info
    const participantId = participantData?.id;
    const participantName = participantData?.name || 'Unknown';

    // Log minimal info to avoid flooding the console
    // console.log(`Received ${frameType} frame from ${participantName} (ID: ${participantId}) at ${frameTimestamp.absolute}`);

    // Send the frame to the renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('video-frame', {
        noteId,
        participantId,
        participantName,
        frameType,
        buffer: frameBuffer,
        timestamp: frameTimestamp
      });
    }
  } catch (error) {
    console.error('Error processing video frame:', error);
  }
}

// Function to process participant join events
async function processParticipantJoin(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in participant join event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the participant data
    const participantData = evt.data.data.participant;
    if (!participantData) {
      console.log("No participant data in event");
      return;
    }

    const participantName = participantData.name || "Unknown Participant";
    const participantId = participantData.id;
    const isHost = participantData.is_host;
    const platform = participantData.platform;

    console.log(`Participant joined: ${participantName} (ID: ${participantId}, Host: ${isHost})`);

    // Skip "Host" and "Guest" generic names
    if (participantName === "Host" || participantName === "Guest" || participantName.includes("others") || (participantName.split(" ").length > 3)) {
      console.log(`Skipping generic participant name: ${participantName}`);
      return;
    }

    // Use the file operation manager to safely update the meetings data
    await fileOperationManager.scheduleOperation(async (meetingsData) => {
      // Find the meeting note with this ID
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === noteId);
      if (noteIndex === -1) {
        console.log(`No meeting note found with ID: ${noteId}`);
        return null; // Return null to indicate no changes needed
      }

      // Get the meeting and initialize participants array if needed
      const meeting = meetingsData.pastMeetings[noteIndex];
      if (!meeting.participants) {
        meeting.participants = [];
      }

      // Check if participant already exists (based on ID)
      const existingParticipantIndex = meeting.participants.findIndex(p => p.id === participantId);

      if (existingParticipantIndex !== -1) {
        // Update existing participant
        meeting.participants[existingParticipantIndex] = {
          id: participantId,
          name: participantName,
          isHost: isHost,
          platform: platform,
          joinTime: new Date().toISOString(),
          status: 'active'
        };
      } else {
        // Add new participant
        meeting.participants.push({
          id: participantId,
          name: participantName,
          isHost: isHost,
          platform: platform,
          joinTime: new Date().toISOString(),
          status: 'active'
        });
      }

      console.log(`Added/updated participant data for meeting: ${noteId}`);

      // Notify the renderer if this note is currently being edited
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('participants-updated', noteId);
      }

      // Return the updated data to be written
      return meetingsData;
    });

    console.log(`Processed participant join event for meeting: ${noteId}`);
  } catch (error) {
    console.error('Error processing participant join event:', error);
  }
}

let currentUnknownSpeaker = -1;

async function processTranscriptProviderData(evt) {
  // let speakerId = evt.data.data.payload.
  try {
    if (evt.data.data.data.payload.channel.alternatives[0].words[0].speaker !== undefined) {
      currentUnknownSpeaker = evt.data.data.data.payload.channel.alternatives[0].words[0].speaker;
    }
  } catch (error) {
    // console.error("Error processing provider data:", error);
  }
}

// Function to process transcript data and store it with the meeting note
async function processTranscriptData(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in transcript event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the transcript data
    const words = evt.data.data.words || [];
    if (words.length === 0) {
      return; // No words to process
    }

    // Get speaker information
    let speaker;
    if (evt.data.data.participant?.name && evt.data.data.participant?.name !== "Host" && evt.data.data.participant?.name !== "Guest") {
      speaker = evt.data.data.participant?.name;
    } else if (currentUnknownSpeaker !== -1) {
      speaker = `Speaker ${currentUnknownSpeaker}`;
    } else {
      speaker = "Unknown Speaker";
    }

    // Combine all words into a single text
    const text = words.map(word => word.text).join(" ");

    console.log(`Transcript from ${speaker}: "${text}"`);

    // Use the file operation manager to safely update the meetings data
    await fileOperationManager.scheduleOperation(async (meetingsData) => {
      // Find the meeting note with this ID
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === noteId);
      if (noteIndex === -1) {
        console.log(`No meeting note found with ID: ${noteId}`);
        return null; // Return null to indicate no changes needed
      }

      // Add the transcript data
      const meeting = meetingsData.pastMeetings[noteIndex];

      // Initialize transcript array if it doesn't exist
      if (!meeting.transcript) {
        meeting.transcript = [];
      }

      // Add the new transcript entry
      meeting.transcript.push({
        text,
        speaker,
        timestamp: new Date().toISOString()
      });

      console.log(`Added transcript data for meeting: ${noteId}`);

      // Notify the renderer if this note is currently being edited
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript-updated', noteId);
      }

      // Return the updated data to be written
      return meetingsData;
    });

    console.log(`Processed transcript data for meeting: ${noteId}`);
  } catch (error) {
    console.error('Error processing transcript data:', error);
  }
}

// Function to generate AI summary from transcript with streaming support
async function generateMeetingSummary(meeting, progressCallback = null) {
  try {
    if (!meeting.transcript || meeting.transcript.length === 0) {
      console.log('No transcript available to summarize');
      return 'No transcript available to summarize.';
    }

    console.log(`Generating AI summary for meeting: ${meeting.id}`);

    // Format the transcript into a single text for the AI to process
    const transcriptText = meeting.transcript.map(entry =>
      `${entry.speaker}: ${entry.text}`
    ).join('\n');

    // Format detected participants if available
    let participantsText = "";
    if (meeting.participants && meeting.participants.length > 0) {
      participantsText = "Detected participants:\n" + meeting.participants.map(p =>
        `- ${p.name}${p.isHost ? ' (Host)' : ''}`
      ).join('\n');
    }

    // Define a system prompt to guide the AI's response with a specific format
    const systemMessage =
      "You are an AI assistant that summarizes meeting transcripts. " +
      "You MUST format your response using the following structure:\n\n" +
      "# Participants\n" +
      "- [List all participants mentioned in the transcript]\n\n" +
      "# Summary\n" +
      "- [Key discussion point 1]\n" +
      "- [Key discussion point 2]\n" +
      "- [Key decisions made]\n" +
      "- [Include any important deadlines or dates mentioned]\n\n" +
      "# Action Items\n" +
      "- [Action item 1] - [Responsible person if mentioned]\n" +
      "- [Action item 2] - [Responsible person if mentioned]\n" +
      "- [Add any other action items discussed]\n\n" +
      "Stick strictly to this format with these exact section headers. Keep each bullet point concise but informative.";

    // Prepare the messages array for the API
    const messages = [
      { role: "system", content: systemMessage },
      {
        role: "user", content: `Summarize the following meeting transcript with the EXACT format specified in your instructions:
${participantsText ? participantsText + "\n\n" : ""}
Transcript:
${transcriptText}`
      }
    ];

    // If no progress callback provided, use the non-streaming version
    if (!progressCallback) {
      // Call the OpenAI API (via OpenRouter) for summarization (non-streaming)
      const response = await openai.chat.completions.create({
        model: MODELS.PRIMARY, // Use our primary model for a good balance of quality and speed
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
        fallbacks: MODELS.FALLBACKS, // Use our defined fallback models
        transform_to_openai: true, // Ensures consistent response format across models
        route: "fallback" // Automatically use fallbacks if the primary model is unavailable
      });

      // Log which model was actually used
      console.log(`AI summary generated successfully using model: ${response.model}`);

      // Return the generated summary
      return response.choices[0].message.content;
    } else {
      // Use streaming version and accumulate the response
      let fullText = '';

      // Create a streaming request
      const stream = await openai.chat.completions.create({
        model: MODELS.PRIMARY, // Use our primary model for a good balance of quality and speed
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
        stream: true,
        fallbacks: MODELS.FALLBACKS, // Use our defined fallback models
        transform_to_openai: true, // Ensures consistent response format across models
        route: "fallback" // Automatically use fallbacks if the primary model is unavailable
      });

      // Handle streaming events
      return new Promise((resolve, reject) => {
        // Process the stream
        (async () => {
          try {
            // Log the model being used when first chunk arrives (if available)
            let modelLogged = false;

            for await (const chunk of stream) {
              // Log the model on first chunk if available
              if (!modelLogged && chunk.model) {
                console.log(`Streaming with model: ${chunk.model}`);
                modelLogged = true;
              }

              // Extract the text content from the chunk
              const content = chunk.choices[0]?.delta?.content || '';

              if (content) {
                // Add the new text chunk to our accumulated text
                fullText += content;

                // Log each token for debugging (less verbose)
                if (content.length < 50) {
                  console.log(`Received token: "${content}"`);
                } else {
                  console.log(`Received content of length: ${content.length}`);
                }

                // Call the progress callback immediately with each token
                if (progressCallback) {
                  progressCallback(fullText);
                }
              }
            }

            console.log('AI summary streaming completed');
            resolve(fullText);
          } catch (error) {
            console.error('Stream error:', error);
            reject(error);
          }
        })();
      });
    }
  } catch (error) {
    console.error('Error generating meeting summary:', error);

    // Re-throw so callers can distinguish errors from valid summaries
    throw error;
  }
}

// Function to update a note with recording information when recording ends
async function updateNoteWithRecordingInfo(recordingId) {
  try {
    const now = new Date();
    const formattedDate = now.toLocaleString();
    let meetingId = null;
    let meetingTitle = null;
    let hasTranscript = false;
    let meetingForSummary = null;

    // Atomically update the recording status
    await fileOperationManager.scheduleOperation((meetingsData) => {
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting =>
        meeting.recordingId === recordingId
      );

      if (noteIndex === -1) {
        console.log('No meeting note found for recording ID:', recordingId);
        return null;
      }

      const meeting = meetingsData.pastMeetings[noteIndex];
      meetingId = meeting.id;
      meetingTitle = meeting.title || "Meeting Notes";
      hasTranscript = meeting.transcript && meeting.transcript.length > 0;

      // Take a snapshot of transcript for summary generation
      if (hasTranscript) {
        meetingForSummary = JSON.parse(JSON.stringify(meeting));
      }

      meeting.content = meeting.content.replace(
        "Recording: In Progress...",
        `Recording: Completed at ${formattedDate}\n`
      );
      meeting.recordingComplete = true;
      meeting.recordingEndTime = now.toISOString();

      return meetingsData;
    });

    if (!meetingId) return;

    // Generate AI summary if there's a transcript
    if (hasTranscript && meetingForSummary) {
      console.log(`Generating AI summary for meeting ${meetingId}...`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('summary-update', {
          meetingId,
          content: `# ${meetingTitle}\nGenerating summary...`
        });
      }

      const streamProgress = (currentText) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('summary-update', {
              meetingId,
              content: `# ${meetingTitle}\n\n${currentText}`,
              timestamp: Date.now()
            });
          } catch (err) {
            console.error('Error sending streaming update to renderer:', err);
          }
        }
      };

      let finalContent;
      let hasSummary;
      try {
        const summary = await generateMeetingSummary(meetingForSummary, streamProgress);
        finalContent = `${summary}`;
        hasSummary = true;
      } catch (summaryError) {
        console.error('Failed to generate AI summary:', summaryError);
        finalContent = `# ${meetingTitle}\n\nSummary generation failed. You can retry using the Auto button.`;
        hasSummary = false;
      }

      // Atomically save the summary without overwriting concurrent transcript writes
      await fileOperationManager.scheduleOperation((currentData) => {
        const m = currentData.pastMeetings.find(m => m.id === meetingId);
        if (m) {
          m.content = finalContent;
          m.hasSummary = hasSummary;
        }
        return currentData;
      });

      console.log('Updated meeting note after recording ended');
    }

    // If the note is currently open, notify the renderer to refresh it
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-completed', meeting.id);
    }
  } catch (error) {
    console.error('Error updating note with recording info:', error);
  }
}

// Function to check if there's a detected meeting available
ipcMain.handle('checkForDetectedMeeting', async () => {
  return detectedMeeting !== null;
});

// Function to join the detected meeting
ipcMain.handle('joinDetectedMeeting', async () => {
  return joinDetectedMeeting();
});

// Function to handle joining a detected meeting
async function joinDetectedMeeting() {
  try {
    console.log("Join detected meeting called");

    if (!detectedMeeting) {
      console.log("No detected meeting available");
      return { success: false, error: "No active meeting detected" };
    }

    // Map platform codes to readable names
    const platformNames = {
      'zoom': 'Zoom',
      'google-meet': 'Google Meet',
      'slack': 'Slack',
      'teams': 'Microsoft Teams'
    };

    // Get a user-friendly platform name, or use the raw platform name if not in our map
    const platformName = platformNames[detectedMeeting.window.platform] || detectedMeeting.window.platform;

    console.log("Joining detected meeting for platform:", platformName);

    // Ensure main window exists and is visible
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log("Creating new main window");
      createWindow();
    }

    // Bring window to front with focus
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    // Process with more reliable timing
    return new Promise((resolve) => {
      // Wait a moment for the window to be fully focused and ready
      setTimeout(async () => {
        console.log("Window is ready, creating new meeting note");

        try {
          // Create a new meeting note and start recording
          const id = await createMeetingNoteAndRecord(platformName);

          console.log("Created new meeting with ID:", id);
          resolve({ success: true, meetingId: id });
        } catch (err) {
          console.error("Error creating meeting note:", err);
          resolve({ success: false, error: err.message });
        }
      }, 800); // Increased timeout for more reliability
    });
  } catch (error) {
    console.error("Error in joinDetectedMeeting:", error);
    return { success: false, error: error.message };
  }
}
