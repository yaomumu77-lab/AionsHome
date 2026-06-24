package com.aion.chat;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Bounded, host-independent LRU cache for replayable chat media. */
final class MediaCacheStore {
    private static final String PREFS = "aion_prefs";
    private static final String KEY_LIMIT_MB = "media_cache_limit_mb";
    private static final int DEFAULT_LIMIT_MB = 1024;
    private static final int MIN_LIMIT_MB = 128;
    private static final int MAX_LIMIT_MB = 4096;
    private static final long MAX_SINGLE_FILE = 100L * 1024L * 1024L;
    private static final long RECENT_PROTECTION_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int BUFFER_SIZE = 32 * 1024;

    private final File cacheDir;
    private final SharedPreferences preferences;
    private final OkHttpClient client;
    private final ExecutorService maintenance = Executors.newSingleThreadExecutor();

    MediaCacheStore(Context context) {
        Context appContext = context.getApplicationContext();
        cacheDir = new File(appContext.getCacheDir(), "media-v1");
        if (!cacheDir.exists()) cacheDir.mkdirs();
        preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        client = new OkHttpClient.Builder()
                .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .build();
        maintenance.execute(this::enforceLimit);
    }

    WebResourceResponse intercept(WebResourceRequest webRequest) {
        if (webRequest == null || !"GET".equalsIgnoreCase(webRequest.getMethod())) return null;
        Uri uri = webRequest.getUrl();
        String path = uri.getPath();
        if (!isCacheablePath(path) || hasHeader(webRequest.getRequestHeaders(), "Range")) return null;

        String key = sha256((path == null ? "" : path)
                + (uri.getEncodedQuery() == null ? "" : "?" + uri.getEncodedQuery()));
        File data = new File(cacheDir, key + ".data");
        File meta = new File(cacheDir, key + ".json");
        try {
            String contentType = readContentType(meta);
            if (data.isFile() && contentType != null) {
                touch(data, meta);
                return response(data, contentType, "hit");
            }
            if (!download(webRequest, data, meta)) return null;
            contentType = readContentType(meta);
            if (contentType == null) return null;
            maintenance.execute(this::enforceLimit);
            return response(data, contentType, "miss-stored");
        } catch (Exception e) {
            data.delete();
            meta.delete();
            return null;
        }
    }

    synchronized JSONObject getInfo() {
        JSONObject result = new JSONObject();
        try {
            result.put("bytes", currentBytes());
            result.put("limitMb", getLimitMb());
            result.put("files", dataFiles().size());
        } catch (Exception ignored) {}
        return result;
    }

    void setLimitMb(int value) {
        int safeValue = Math.max(MIN_LIMIT_MB, Math.min(MAX_LIMIT_MB, value));
        preferences.edit().putInt(KEY_LIMIT_MB, safeValue).apply();
        maintenance.execute(this::enforceLimit);
    }

    void clear() {
        maintenance.execute(() -> {
            File[] files = cacheDir.listFiles();
            if (files == null) return;
            for (File file : files) file.delete();
        });
    }

    void shutdown() {
        maintenance.shutdown();
    }

    private boolean download(WebResourceRequest webRequest, File data, File meta) {
        Request.Builder builder = new Request.Builder().url(webRequest.getUrl().toString());
        copyHeader(webRequest.getRequestHeaders(), builder, "User-Agent");
        copyHeader(webRequest.getRequestHeaders(), builder, "Accept");
        String cookie = CookieManager.getInstance().getCookie(webRequest.getUrl().toString());
        if (cookie != null && !cookie.trim().isEmpty()) builder.header("Cookie", cookie);

        File tempData = new File(cacheDir, data.getName() + ".part");
        File tempMeta = new File(cacheDir, meta.getName() + ".part");
        try (Response response = client.newCall(builder.build()).execute()) {
            ResponseBody body = response.body();
            if (!response.isSuccessful() || body == null) return false;
            long announcedLength = body.contentLength();
            if (announcedLength > MAX_SINGLE_FILE) return false;
            String contentType = response.header("Content-Type", "application/octet-stream");
            int semicolon = contentType.indexOf(';');
            if (semicolon >= 0) contentType = contentType.substring(0, semicolon).trim();
            if (!isMediaContentType(contentType)) return false;

            long written = 0;
            try (InputStream input = new BufferedInputStream(body.byteStream());
                 OutputStream output = new BufferedOutputStream(new FileOutputStream(tempData))) {
                byte[] buffer = new byte[BUFFER_SIZE];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    written += count;
                    if (written > MAX_SINGLE_FILE) throw new java.io.IOException("media too large");
                    output.write(buffer, 0, count);
                }
            }
            JSONObject metadata = new JSONObject();
            metadata.put("contentType", contentType);
            metadata.put("sourcePath", webRequest.getUrl().getPath());
            try (OutputStream output = new FileOutputStream(tempMeta)) {
                output.write(metadata.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            replace(tempData, data);
            replace(tempMeta, meta);
            return true;
        } catch (Exception e) {
            tempData.delete();
            tempMeta.delete();
            return false;
        }
    }

    private synchronized void enforceLimit() {
        List<File> files = dataFiles();
        long total = 0;
        for (File file : files) total += file.length();
        long limit = getLimitMb() * 1024L * 1024L;
        if (total <= limit) return;

        long target = (long) (limit * 0.70d);
        long recentCutoff = System.currentTimeMillis() - RECENT_PROTECTION_MS;
        files.sort(Comparator.comparingLong(File::lastModified));
        total = deleteUntil(files, total, target, recentCutoff);
        if (total > target) deleteUntil(files, total, target, Long.MAX_VALUE);
    }

    private long deleteUntil(List<File> files, long total, long target, long newestAllowed) {
        for (File data : files) {
            if (total <= target) break;
            if (!data.exists() || data.lastModified() > newestAllowed) continue;
            long size = data.length();
            File meta = new File(cacheDir, data.getName().replace(".data", ".json"));
            if (data.delete()) total -= size;
            meta.delete();
        }
        return total;
    }

    private List<File> dataFiles() {
        List<File> result = new ArrayList<>();
        File[] files = cacheDir.listFiles();
        if (files == null) return result;
        for (File file : files) {
            if (file.isFile() && file.getName().endsWith(".data")) result.add(file);
            else if (file.getName().endsWith(".part")) file.delete();
        }
        return result;
    }

    private long currentBytes() {
        long total = 0;
        for (File file : dataFiles()) total += file.length();
        return total;
    }

    private int getLimitMb() {
        return Math.max(MIN_LIMIT_MB, Math.min(MAX_LIMIT_MB,
                preferences.getInt(KEY_LIMIT_MB, DEFAULT_LIMIT_MB)));
    }

    static boolean isCacheablePath(String path) {
        if (path == null) return false;
        return path.startsWith("/uploads/")
                || path.startsWith("/cr-uploads/")
                || path.startsWith("/api/tts/audio/")
                || path.startsWith("/api/theater/tts/audio/")
                || path.startsWith("/api/gift/thumbnail/")
                || (path.startsWith("/api/diaries/") && path.endsWith("/tts/audio"));
    }

    private static boolean isMediaContentType(String value) {
        String type = value.toLowerCase(Locale.ROOT);
        return type.startsWith("audio/") || type.startsWith("image/")
                || type.startsWith("video/");
    }

    private static WebResourceResponse response(File file, String contentType, String state)
            throws Exception {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Media-Cache", state);
        return new WebResourceResponse(contentType, null, 200, "OK", headers,
                new BufferedInputStream(new FileInputStream(file)));
    }

    private static String readContentType(File meta) {
        if (!meta.isFile() || meta.length() > 16 * 1024) return null;
        try (InputStream input = new FileInputStream(meta)) {
            byte[] bytes = new byte[(int) meta.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) break;
                offset += count;
            }
            return new JSONObject(new String(bytes, 0, offset,
                    java.nio.charset.StandardCharsets.UTF_8)).getString("contentType");
        } catch (Exception e) {
            return null;
        }
    }

    private static void touch(File... files) {
        long now = System.currentTimeMillis();
        for (File file : files) file.setLastModified(now);
    }

    private static void replace(File source, File destination) throws Exception {
        if (destination.exists() && !destination.delete()) throw new java.io.IOException("delete");
        if (!source.renameTo(destination)) throw new java.io.IOException("rename");
    }

    private static boolean hasHeader(Map<String, String> headers, String name) {
        if (headers == null) return false;
        for (String key : headers.keySet()) if (name.equalsIgnoreCase(key)) return true;
        return false;
    }

    private static void copyHeader(Map<String, String> headers, Request.Builder builder,
                                   String name) {
        if (headers == null) return;
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if (name.equalsIgnoreCase(header.getKey()) && header.getValue() != null) {
                builder.header(name, header.getValue());
                return;
            }
        }
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) result.append(String.format(Locale.ROOT, "%02x", item));
            return result.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
