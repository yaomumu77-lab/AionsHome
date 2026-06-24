package com.aion.chat;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CachePolicyTest {
    @Test
    public void manifestEndpointKeepsSelectedRouteOrigin() {
        assertEquals("http://192.168.1.92:8080/api/client-assets",
                SharedAssetCache.buildManifestUrl("http://192.168.1.92:8080/chat"));
        assertEquals("http://100.117.195.40:8080/api/client-assets",
                SharedAssetCache.buildManifestUrl("http://100.117.195.40:8080/chat"));
        assertEquals("https://chat.aionshome.com/api/client-assets",
                SharedAssetCache.buildManifestUrl("https://chat.aionshome.com/chat"));
    }

    @Test
    public void mediaPolicyCachesReplayableChatMediaOnly() {
        assertTrue(MediaCacheStore.isCacheablePath("/uploads/voice-message.m4a"));
        assertTrue(MediaCacheStore.isCacheablePath("/cr-uploads/2026-06-21/photo.jpg"));
        assertTrue(MediaCacheStore.isCacheablePath("/api/tts/audio/message-1"));
        assertTrue(MediaCacheStore.isCacheablePath("/api/theater/tts/audio/message-2"));
        assertTrue(MediaCacheStore.isCacheablePath("/api/gift/thumbnail/gift-1"));
        assertTrue(MediaCacheStore.isCacheablePath("/api/diaries/entry-1/tts/audio"));

        assertFalse(MediaCacheStore.isCacheablePath("/api/messages"));
        assertFalse(MediaCacheStore.isCacheablePath("/api/music/stream/123"));
        assertFalse(MediaCacheStore.isCacheablePath("/public/wallpaper/large.mp4"));
    }
}
