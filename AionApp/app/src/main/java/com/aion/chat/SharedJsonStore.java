package com.aion.chat;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Locale;

/** Small persistent JSON snapshots shared across all WebView origins. */
final class SharedJsonStore {
    private static final int MAX_VALUE_BYTES = 1024 * 1024;
    private final File directory;

    SharedJsonStore(Context context) {
        directory = new File(context.getApplicationContext().getFilesDir(), "shared-json-v1");
        if (!directory.exists()) directory.mkdirs();
    }

    synchronized String get(String key) {
        if (!validKey(key)) return "";
        File file = fileFor(key);
        if (!file.isFile() || file.length() > MAX_VALUE_BYTES) return "";
        try (InputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) break;
                offset += count;
            }
            file.setLastModified(System.currentTimeMillis());
            return new String(bytes, 0, offset, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    synchronized void put(String key, String value) {
        if (!validKey(key) || value == null) return;
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > MAX_VALUE_BYTES) return;
        File destination = fileFor(key);
        File temp = new File(directory, destination.getName() + ".part");
        try (OutputStream output = new FileOutputStream(temp)) {
            output.write(bytes);
        } catch (Exception e) {
            temp.delete();
            return;
        }
        if (destination.exists()) destination.delete();
        if (!temp.renameTo(destination)) temp.delete();
    }

    private File fileFor(String key) {
        return new File(directory, sha256(key) + ".json");
    }

    private static boolean validKey(String key) {
        return key != null && !key.trim().isEmpty() && key.length() <= 160;
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(
                    value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) result.append(String.format(Locale.ROOT, "%02x", item));
            return result.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
