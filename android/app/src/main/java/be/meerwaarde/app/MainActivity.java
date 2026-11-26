package be.meerwaarde.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;

/**
 * Toont browser/index.html (meegeleverd als asset) in een WebView, op een eigen https-adres zodat
 * localStorage, Web Crypto (synchroniseren) en de camera (QR-code scannen) werken zoals in de browser.
 * Alle gegevens blijven in de opslag van de app op dit toestel.
 */
public class MainActivity extends Activity {
    // Gereserveerd adres voor app-inhoud: wordt nooit over het netwerk opgevraagd (zie shouldInterceptRequest).
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";
    private static final int REQ_FILE = 1, REQ_SAVE = 2, REQ_CAMERA = 3;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest cameraRequest;
    private byte[] pendingSave;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff1f5f8b);
        web = new WebView(this);
        root.addView(web);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) { // Android 15 tekent tot aan de randen: ruimte laten voor balken en toetsenbord
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        web.addJavascriptInterface(new Bridge(), "MeerwaardeAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null; // gewoon netwerk (bv. de sync-server)
                String path = u.getPath() == null || u.getPath().equals("/") ? "index.html" : u.getPath().substring(1);
                try {
                    InputStream in = getAssets().open(path);
                    WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
                    r.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-store"));
                    return r;
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true; // externe links in de gewone browser
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*"); // bestandsbeheerders kennen .csv/.xlsx/.json niet altijd onder hun MIME-type
                try { startActivityForResult(Intent.createChooser(i, "Bestand kiezen"), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest req) {
                boolean camera = false;
                for (String r : req.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) camera = true;
                if (!camera || !HOST.equals(req.getOrigin().getHost())) { req.deny(); return; }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    cameraRequest = req;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                }
            }
        });

        if (saved != null) web.restoreState(saved);
        if (web.getUrl() == null) web.loadUrl(START);
    }

    /** Wordt vanuit app.js aangeroepen (offerDownload) om een back-up, CSV of PDF te bewaren. */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String filename, String mime, String base64) {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> {
                pendingSave = data;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, filename);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (ActivityNotFoundException e) { pendingSave = null; toast("Geen app gevonden om het bestand te bewaren."); }
            });
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        Uri uri = res == RESULT_OK && data != null ? data.getData() : null;
        if (req == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
            fileCallback = null;
        } else if (req == REQ_SAVE) {
            byte[] bytes = pendingSave;
            pendingSave = null;
            if (uri == null || bytes == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException();
                out.write(bytes);
                toast("Bewaard");
            } catch (IOException e) {
                toast("Bewaren mislukt.");
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req != REQ_CAMERA || cameraRequest == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            cameraRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            cameraRequest.deny();
        }
        cameraRequest = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    private void toast(String msg) { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }
}
