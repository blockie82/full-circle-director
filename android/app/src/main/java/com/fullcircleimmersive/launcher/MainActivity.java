package com.fullcircleimmersive.launcher;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.text.TextUtils;
import android.widget.TextView;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Full Circle Player launcher for Meta Quest.
 * Finds Full Circle Director on the Wi-Fi (UDP broadcast "FCD-DISCOVER", answered by the Director)
 * and opens the player in the Meta Quest Browser, which is what plays the 360 / 180 / 3D content.
 */
public class MainActivity extends Activity {
    static final int DISCOVERY_PORT = 8443;
    static final int DEFAULT_PORT = 8443;
    static final String BROWSER = "com.oculus.browser";
    static final String PREFS = "fc";
    static final long SEARCH_MS = 15000;

    static final int BG = Color.rgb(11, 8, 24), CARD = Color.rgb(24, 19, 44), TEXT = Color.WHITE,
            MUTED = Color.rgb(170, 165, 195), ACCENT = Color.rgb(78, 205, 220), LINE = Color.rgb(60, 52, 96);

    final Handler ui = new Handler(Looper.getMainLooper());
    final Map<String, Director> found = new LinkedHashMap<>();
    TextView status;
    LinearLayout list;
    EditText address;
    Button searchBtn;
    SharedPreferences prefs;
    volatile boolean searching;
    volatile Thread searchThread;
    boolean autoOpen = true;     // open by itself once, on launch; after that the operator chooses
    WifiManager.MulticastLock lock;

    static class Director {
        String ip, name, version; int port;
        String url() { return "https://" + ip + ":" + port + "/"; }
    }

    // ------------------------------------------------------------------ screen
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(32), dp(28), dp(32), dp(28));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        root.addView(logo, new LinearLayout.LayoutParams(dp(88), dp(88)));

        TextView title = text("Full Circle Player", 26, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, dp(12), 0, 0);
        root.addView(title);
        TextView by = text("by Full Circle Immersive", 14, MUTED);
        root.addView(by);

        status = text("", 17, TEXT);
        status.setPadding(0, dp(24), 0, dp(12));
        status.setGravity(Gravity.CENTER);
        root.addView(status);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        root.addView(list, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        searchBtn = button("Search again", false);
        searchBtn.setOnClickListener(v -> startSearch());
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sp.topMargin = dp(8);
        root.addView(searchBtn, sp);

        TextView or = text("Or type the address shown in the Director", 14, MUTED);
        or.setPadding(0, dp(28), 0, dp(8));
        root.addView(or);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        address = new EditText(this);
        address.setSingleLine(true);
        address.setHint("e.g. 192.168.8.10");
        address.setHintTextColor(Color.rgb(110, 104, 140));
        address.setTextColor(TEXT);
        address.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setBackground(box(CARD, LINE));
        address.setPadding(dp(14), dp(10), dp(14), dp(10));
        String last = prefs.getString("lastIp", "");
        if (!last.isEmpty()) address.setText(last);
        address.setOnEditorActionListener((v, id, e) -> {
            if (id == EditorInfo.IME_ACTION_GO || (e != null && e.getKeyCode() == KeyEvent.KEYCODE_ENTER)) { openTyped(); return true; }
            return false;
        });
        row.addView(address, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        Button go = button("Open", true);
        go.setOnClickListener(v -> openTyped());
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        gp.leftMargin = dp(10);
        row.addView(go, gp);
        root.addView(row, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView hint = text("The headset and the Director's PC must be on the same Wi-Fi.", 13, MUTED);
        hint.setPadding(0, dp(24), 0, 0);
        hint.setGravity(Gravity.CENTER);
        root.addView(hint);

        // centre a column of at most 680dp, so it fits a narrow panel and doesn't sprawl on a wide one
        LinearLayout outer = new LinearLayout(this);
        outer.setGravity(Gravity.CENTER_HORIZONTAL);
        outer.setBackgroundColor(BG);
        column = root;
        outer.addView(root, new LinearLayout.LayoutParams(columnWidth(), LinearLayout.LayoutParams.WRAP_CONTENT));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        scroll.addView(outer);
        setContentView(scroll);
    }

    LinearLayout column;

    int columnWidth() {
        int w = getResources().getDisplayMetrics().widthPixels;
        return Math.min(w, dp(680));
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        if (column != null) {
            column.getLayoutParams().width = columnWidth();
            column.requestLayout();
        }
    }

    @Override protected void onResume() {
        super.onResume();
        startSearch();
    }

    @Override protected void onPause() {
        super.onPause();
        stopSearch();
    }

    // ------------------------------------------------------------------ discovery
    void startSearch() {
        stopSearch();
        synchronized (found) { found.clear(); }
        renderList();
        setStatus("Looking for Full Circle Director…");
        searchBtn.setEnabled(false);
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) { lock = wm.createMulticastLock("fc-discovery"); lock.setReferenceCounted(false); lock.acquire(); }
        } catch (Exception ignored) {}
        searching = true;
        final String lastIp = prefs.getString("lastIp", "");
        Thread t = new Thread(() -> search(lastIp), "fc-discovery");
        searchThread = t;
        t.start();
    }

    void stopSearch() {
        searching = false;
        Thread t = searchThread;
        if (t != null) t.interrupt();
        searchThread = null;
        try { if (lock != null && lock.isHeld()) lock.release(); } catch (Exception ignored) {}
    }

    void search(String lastIp) {
        long end = System.currentTimeMillis() + SEARCH_MS, nextSend = 0;
        long firstFound = 0;
        byte[] ask = "FCD-DISCOVER 1".getBytes(StandardCharsets.UTF_8);
        try (DatagramSocket sock = new DatagramSocket()) {
            sock.setBroadcast(true);
            sock.setSoTimeout(300);
            byte[] buf = new byte[4096];
            while (searching && System.currentTimeMillis() < end) {
                long now = System.currentTimeMillis();
                if (now >= nextSend) {
                    for (InetAddress a : targets(lastIp)) {
                        try { sock.send(new DatagramPacket(ask, ask.length, a, DISCOVERY_PORT)); } catch (Exception ignored) {}
                    }
                    nextSend = now + 1000;
                }
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    sock.receive(p);
                    Director d = parse(p);
                    if (d != null) {
                        boolean isNew;
                        synchronized (found) { isNew = !found.containsKey(d.ip); found.put(d.ip, d); }
                        if (isNew) {
                            if (firstFound == 0) firstFound = System.currentTimeMillis();
                            ui.post(this::renderList);
                        }
                    }
                } catch (SocketTimeoutException ignored) {
                } catch (Exception e) { if (!searching) break; }

                // give a second Director (if there is one) a moment to answer, then decide
                if (firstFound > 0 && System.currentTimeMillis() - firstFound > 900 && autoOpen) {
                    ui.post(this::foundDecide);
                    firstFound = -1;
                }
            }
        } catch (Exception e) {
            ui.post(() -> setStatus("Couldn't search the network: " + e.getMessage()));
        }
        if (searchThread == Thread.currentThread()) ui.post(this::searchFinished);
    }

    List<InetAddress> targets(String lastIp) {
        List<InetAddress> out = new ArrayList<>();
        try { out.add(InetAddress.getByName("255.255.255.255")); } catch (Exception ignored) {}
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress bc = ia.getBroadcast();
                    if (bc != null && !out.contains(bc)) out.add(bc);
                }
            }
        } catch (Exception ignored) {}
        // ask the last Director directly too, in case the router blocks broadcasts
        if (lastIp != null && !lastIp.isEmpty()) {
            try { out.add(InetAddress.getByName(lastIp)); } catch (Exception ignored) {}
        }
        return out;
    }

    Director parse(DatagramPacket p) {
        try {
            JSONObject j = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
            if (!"Full Circle Director".equals(j.optString("app"))) return null;
            Director d = new Director();
            d.ip = p.getAddress().getHostAddress();   // the address that actually reached us
            d.port = j.optInt("port", DEFAULT_PORT);
            d.name = j.optString("name", "Director");
            d.version = j.optString("version", "");
            return d;
        } catch (Exception e) { return null; }
    }

    void foundDecide() {
        List<Director> ds;
        synchronized (found) { ds = new ArrayList<>(found.values()); }
        if (ds.size() == 1 && autoOpen) {
            setStatus("Found " + ds.get(0).name + " – opening the player…");
            ui.postDelayed(() -> { if (autoOpen) open(ds.get(0)); }, 600);
        } else if (ds.size() > 1) {
            setStatus("More than one Director found. Choose one:");
        }
    }

    void searchFinished() {
        searchBtn.setEnabled(true);
        int n;
        synchronized (found) { n = found.size(); }
        if (n == 0) setStatus("Couldn't find the Director.\nCheck it's running on the PC and both are on the same Wi-Fi,\nor type its address below.");
        else if (n == 1 && !autoOpen) setStatus("Ready.");
        else if (n > 1) setStatus("Choose a Director:");
    }

    // ------------------------------------------------------------------ opening the player
    void openTyped() {
        String s = address.getText().toString().trim();
        if (s.isEmpty()) return;
        String url = s;
        if (!url.contains("://")) url = "https://" + url;
        Uri u = Uri.parse(url);
        if (u.getHost() == null) { setStatus("That address doesn't look right."); return; }
        if (u.getPort() == -1) url = u.getScheme() + "://" + u.getHost() + ":" + DEFAULT_PORT + "/";
        prefs.edit().putString("lastIp", u.getHost()).apply();
        launch(url);
    }

    void open(Director d) {
        prefs.edit().putString("lastIp", d.ip).apply();
        address.setText(d.ip);
        launch(d.url());
    }

    void launch(String url) {
        autoOpen = false;
        stopSearch();
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            i.setPackage(BROWSER);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            try { i.setPackage(null); startActivity(i); }
            catch (ActivityNotFoundException e2) { setStatus("No browser found to open " + url); return; }
        }
        setStatus("Player opened in the Quest Browser.");
    }

    // ------------------------------------------------------------------ list + helpers
    void renderList() {
        list.removeAllViews();
        List<Director> ds;
        synchronized (found) { ds = new ArrayList<>(found.values()); }
        for (Director d : ds) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.HORIZONTAL);
            card.setGravity(Gravity.CENTER_VERTICAL);
            card.setBackground(box(CARD, LINE));
            card.setPadding(dp(16), dp(12), dp(12), dp(12));
            LinearLayout txt = new LinearLayout(this);
            txt.setOrientation(LinearLayout.VERTICAL);
            TextView n = text(d.name, 17, TEXT);
            n.setGravity(Gravity.START);
            n.setTypeface(Typeface.DEFAULT_BOLD);
            n.setSingleLine(true); n.setEllipsize(TextUtils.TruncateAt.END);
            TextView a = text(d.ip + (d.version.isEmpty() ? "" : "  ·  Director " + d.version), 13, MUTED);
            a.setGravity(Gravity.START);
            a.setSingleLine(true); a.setEllipsize(TextUtils.TruncateAt.END);
            txt.addView(n); txt.addView(a);
            card.addView(txt, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            Button b = button("Open player", true);
            b.setOnClickListener(v -> open(d));
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            bp.leftMargin = dp(12);
            card.addView(b, bp);
            card.setOnClickListener(v -> open(d));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(8);
            list.addView(card, lp);
        }
    }

    void setStatus(String s) { status.setText(s); }

    TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        return t;
    }

    Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(primary ? BG : TEXT);
        b.setBackground(primary ? box(ACCENT, ACCENT) : box(Color.TRANSPARENT, LINE));
        b.setPadding(dp(18), dp(8), dp(18), dp(8));
        b.setMinHeight(0); b.setMinimumHeight(0);
        return b;
    }

    GradientDrawable box(int fill, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(12));
        g.setStroke(dp(1), stroke);
        return g;
    }

    int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
