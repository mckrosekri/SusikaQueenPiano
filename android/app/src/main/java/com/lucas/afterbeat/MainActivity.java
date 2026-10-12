package com.lucas.afterbeat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Build;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean noisyReceiverRegistered;

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                dispatchAudioInterruption("audio_route_changed");
            }
        }
    };

    @Override
    public void onResume() {
        super.onResume();
        if (!noisyReceiverRegistered) {
            IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // The protected broadcast is sent by Android's audio service, outside this app's UID.
                registerReceiver(noisyReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(noisyReceiver, filter);
            }
            noisyReceiverRegistered = true;
        }
    }

    @Override
    public void onPause() {
        if (noisyReceiverRegistered) {
            unregisterReceiver(noisyReceiver);
            noisyReceiverRegistered = false;
        }
        super.onPause();
    }

    private void dispatchAudioInterruption(String reason) {
        runOnUiThread(() -> {
            if (getBridge() == null) return;
            WebView webView = getBridge().getWebView();
            if (webView == null) return;
            String script = "window.dispatchEvent(new CustomEvent('afterbeat:audio-interruption',{detail:{reason:'"
                + reason + "'}}));";
            webView.evaluateJavascript(script, null);
        });
    }
}
