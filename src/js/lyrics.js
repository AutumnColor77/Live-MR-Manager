/**
 * src/js/lyrics.js - LRC Lyric Parsing Utility
 */

import { invoke } from './tauri-bridge.js';

/**
 * Parses a raw LRC string into a segment array
 * @param {string} lrcContent 
 * @param {number} duration 
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function parseLrc(lrcContent, duration = 0) {
    if (!lrcContent) return [];
    
    const lines = lrcContent.split('\n');
    const segments = [];
    const timeRegex = /\[(\d{2}):(\d{2}\.\d{2,3})\]/;
    
    lines.forEach(line => {
        const match = timeRegex.exec(line);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseFloat(match[2]);
            const timeStr = match[0];
            const text = line.replace(timeStr, '').trim();
            segments.push({ text, start: min * 60 + sec, end: 0 });
        } else if (line.trim()) {
            // Lines without timestamps (metadata or raw text without sync)
            segments.push({ text: line.trim(), start: 0, end: 0 });
        }
    });
    
    // Calculate end times based on the next line's start time
    for (let i = 0; i < segments.length - 1; i++) {
        if (segments[i].start > 0 && segments[i+1].start > 0) {
            segments[i].end = segments[i+1].start;
        } else {
            segments[i].end = 0;
        }
    }
    
    if (segments.length > 0) {
        // Last segment ends at track duration or remains 0 if unknown
        segments[segments.length - 1].end = duration > 0 ? duration : 0;
    }

    return segments;
}

/**
 * Loads and parses LRC file for a given audio path
 * @param {string} audioPath 
 * @param {number} duration 
 * @returns {Promise<Array>}
 */
export async function loadLyricsForTrack(audioPath, duration = 0) {
    try {
        const content = await invoke('load_lrc_file', { audioPath });
        if (content && content.trim()) {
            return parseLrc(content, duration);
        }
    } catch (err) {
        console.log("[Lyrics] No LRC file found or load failed:", err);
    }
    return [];
}
