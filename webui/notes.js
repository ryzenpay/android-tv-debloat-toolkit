// Generated from adb_core.py KNOWN_NOTES — do not hand-edit; re-run: python3 -c "import adb_core,json;..."
export const KNOWN_NOTES = {
 "android.autoinstalls.config.BRAND_NAME": [
  "bloat",
  "Play Store auto-install config — lets Google push apps onto the box."
 ],
 "android.energymode.overlay": [
  "careful",
  "Rewrites TV Settings energy-mode options; framework-res is not the target."
 ],
 "android.overlay.common": [
  "careful",
  "Common framework resource overlay."
 ],
 "android.tvsettings.sdmc.overlay": [
  "careful",
  "TV Settings brand resoverlay (device manufacturer config)."
 ],
 "com.amazon.amazonvideo.livingroom": [
  "careful",
  "Prime Video for TV; a Play-installed copy is refused, sideloaded is yours to remove."
 ],
 "com.android.adservices.api": [
  "bloat",
  "Android 14 Privacy Sandbox ad APIs; nothing you watch depends on them."
 ],
 "com.android.backupconfirm": [
  "bloat",
  "The 'back up your data' confirmation dialog."
 ],
 "com.android.bluetooth": [
  "keep",
  "Bluetooth stack; the remote pairs over BLE."
 ],
 "com.android.cameraextensions": [
  "keep",
  "Camera extensions HAL glue."
 ],
 "com.android.captiveportallogin": [
  "keep",
  "Captive-portal sign-in page for hotel and public Wi-Fi."
 ],
 "com.android.certinstaller": [
  "keep",
  "Installs CA certificates — needed for proxy debugging."
 ],
 "com.android.companiondevicemanager": [
  "keep",
  "Companion-device pairing API used by watch and wearable apps."
 ],
 "com.android.connectivity.resources": [
  "keep",
  "Overlay of framework resources for connectivity."
 ],
 "com.android.cts.ctsshim": [
  "bloat",
  "CTS compatibility-test shim left in the system image."
 ],
 "com.android.cts.priv.ctsshim": [
  "bloat",
  "Privileged CTS compatibility-test shim."
 ],
 "com.android.devicelockcontroller": [
  "keep",
  "Device lock/management controller (device policy)."
 ],
 "com.android.dreams.basic": [
  "bloat",
  "Stock clocks and screensavers."
 ],
 "com.android.dreams.phototable": [
  "bloat",
  "AOSP Photo Table screensaver — replaces only the dream you already have."
 ],
 "com.android.dynsystem": [
  "bloat",
  "Dynamic system-partition installer, dead weight on a locked box."
 ],
 "com.android.emergency": [
  "bloat",
  "Emergency-info/dialing stub with nothing to dial from a TV."
 ],
 "com.android.externalstorage": [
  "keep",
  "Handles USB storage mounts."
 ],
 "com.android.federatedcompute.services": [
  "bloat",
  "Federated-compute worker that trains Google's models on this device."
 ],
 "com.android.health.connect.backuprestore": [
  "keep",
  "Health Connect backup/restore component (id used on this build)."
 ],
 "com.android.healthconnect.backuprestore": [
  "keep",
  "Health Connect backup/restore component."
 ],
 "com.android.healthconnect.controller": [
  "keep",
  "Health Connect — privacy dashboard for health-data apps."
 ],
 "com.android.hotspot2.osulogin": [
  "careful",
  "Passpoint/Hotspot 2.0 sign-in for managed Wi-Fi."
 ],
 "com.android.htmlviewer": [
  "bloat",
  "Opens raw HTML files pulled off USB storage."
 ],
 "com.android.inputdevices": [
  "keep",
  "Input-device configuration; the remote is an input device."
 ],
 "com.android.intentresolver": [
  "keep",
  "Resolves intents and direct-share targets; part of the share sheet."
 ],
 "com.android.keychain": [
  "keep",
  "System keystore access prompts."
 ],
 "com.android.localtransport": [
  "keep",
  "Local transport for debug/logging."
 ],
 "com.android.location.fused": [
  "keep",
  "Fused location provider — two sources report a boot loop after disabling it."
 ],
 "com.android.managedprovisioning": [
  "keep",
  "Work-profile / device-admin provisioning flow."
 ],
 "com.android.nearby.halfsheet": [
  "careful",
  "Nearby Share half-sheet — phones stop offering to hand content to the TV."
 ],
 "com.android.networkstack": [
  "keep",
  "Wi-Fi/networking depends on it."
 ],
 "com.android.networkstack.tethering": [
  "keep",
  "Tethering/hotspot half of the network stack."
 ],
 "com.android.ondevicepersonalization.services": [
  "bloat",
  "On-device personalization service feeding Google's content/ad models."
 ],
 "com.android.pacprocessor": [
  "keep",
  "Proxy auto-config processor — a manual proxy setup stops resolving."
 ],
 "com.android.printspooler": [
  "bloat",
  "Print spooler; there is no printer stack on a TV."
 ],
 "com.android.providers.calendar": [
  "bloat",
  "Calendar database, only useful with a calendar app."
 ],
 "com.android.providers.contacts": [
  "bloat",
  "Contacts database, unused on a TV."
 ],
 "com.android.providers.downloads": [
  "keep",
  "Download manager used by in-app downloads."
 ],
 "com.android.providers.media": [
  "keep",
  "MediaProvider (legacy id); older builds resolve media through it."
 ],
 "com.android.providers.media.module": [
  "keep",
  "Updatable MediaProvider; USB storage reads fail without it."
 ],
 "com.android.providers.settings": [
  "keep",
  "The Settings database itself."
 ],
 "com.android.providers.settings.overlay.common": [
  "careful",
  "Overlay on the Settings provider resources."
 ],
 "com.android.providers.tv": [
  "keep",
  "TvProvider holds channel/input data."
 ],
 "com.android.providers.userdictionary": [
  "bloat",
  "Keyboard user dictionary."
 ],
 "com.android.proxyhandler": [
  "keep",
  "Handles system proxy settings."
 ],
 "com.android.rkpdapp": [
  "keep",
  "Remote Key Provisioning service — the framework asks it for device-backed keys."
 ],
 "com.android.sdksandbox": [
  "keep",
  "Sandbox for SDK feature modules and instant apps."
 ],
 "com.android.se": [
  "keep",
  "Secure Element service; the NFC payment stack breaks without it."
 ],
 "com.android.settings.intelligence": [
  "keep",
  "Search inside Settings."
 ],
 "com.android.sharedstoragebackup": [
  "bloat",
  "Shared-storage backup stub."
 ],
 "com.android.shell": [
  "keep",
  "adb shell runs under this package — disabling it kills ADB access."
 ],
 "com.android.statementservice": [
  "careful",
  "App-link verification; disabling breaks deep links into apps."
 ],
 "com.android.systemui": [
  "keep",
  "Volume overlay, system dialogs, picture-in-picture."
 ],
 "com.android.tv.feedbackconsent": [
  "bloat",
  "Shows and stores the 'help improve Google TV' consent dialog."
 ],
 "com.android.tv.frameworkpackagestubs": [
  "careful",
  "Stubs GMS routes framework intents through; breaks sign-in UI on some builds."
 ],
 "com.android.tv.globalkeyhandler": [
  "careful",
  "Handles the GLOBAL_BUTTON broadcasts behind the remote's customisable keys."
 ],
 "com.android.tv.overlay.framework": [
  "careful",
  "Framework resource overlay for TV behaviour."
 ],
 "com.android.tv.overlay.framework.globalkeysoverlay": [
  "careful",
  "Framework overlay mapping TV global keys."
 ],
 "com.android.tv.overlay.networkstack": [
  "careful",
  "Network-stack resource overlay for TV."
 ],
 "com.android.tv.overlay.settingsprovider": [
  "careful",
  "TvProvider/settings-provider resource overlay."
 ],
 "com.android.tv.overlay.wifi.resources": [
  "careful",
  "Wi-Fi resource overlay in the TV overlay set."
 ],
 "com.android.tv.settings": [
  "keep",
  "The TV's own Settings app."
 ],
 "com.android.tv.settings.gms.resoverlay": [
  "careful",
  "Google Mobile Services resoverlay for TV Settings."
 ],
 "com.android.tv.settings.google.resoverlay": [
  "careful",
  "Google-specific resoverlay for TV Settings."
 ],
 "com.android.tv.settings.overlay": [
  "careful",
  "Installed but not enabled in the device's overlay list — inert as it stands."
 ],
 "com.android.tv.settings.rtk.resoverlay": [
  "careful",
  "Realtek vendor resoverlay for TV Settings."
 ],
 "com.android.tv.settings.vendor.resoverlay": [
  "careful",
  "Board vendor resoverlay for TV Settings."
 ],
 "com.android.uwb.resources": [
  "keep",
  "Overlay of framework resources for Ultra Wideband."
 ],
 "com.android.vending": [
  "keep",
  "Play Store."
 ],
 "com.android.virtualmachine.res": [
  "bloat",
  "Placeholder resources for the VM feature; no VM runs on a TV."
 ],
 "com.android.vpndialogs": [
  "keep",
  "The 'VPN will monitor your traffic' prompt; without it VPNs cannot connect."
 ],
 "com.android.wallpaperbackup": [
  "bloat",
  "Backs wallpapers to the cloud; a TV has no wallpaper picker."
 ],
 "com.android.wifi.dialog": [
  "keep",
  "Wi-Fi permission and connection dialogs."
 ],
 "com.android.wifi.resources": [
  "keep",
  "Overlay of framework resources for Wi-Fi."
 ],
 "com.dolby.android.audio.service": [
  "keep",
  "Dolby audio service on the output path."
 ],
 "com.droidlogic.launcher.provider": [
  "keep",
  "TvProvider for the vendor launcher — channel and input data."
 ],
 "com.droidlogic.launcher.provider.overlay": [
  "careful",
  "Overlay on the vendor launcher's channel provider resources."
 ],
 "com.droidlogic.overlay": [
  "careful",
  "Vendor framework resource overlay."
 ],
 "com.google.android.apps.mediashell": [
  "bloat",
  "DIAL/Cast receiver daemon (only if you never cast *to* this box)."
 ],
 "com.google.android.apps.tv.dreamx": [
  "bloat",
  "Ambient-mode screensaver content and its ads."
 ],
 "com.google.android.apps.tv.launcherx": [
  "careful",
  "The Google TV home screen itself; the Home key has nowhere to go without it."
 ],
 "com.google.android.backdrop": [
  "bloat",
  "Ambient/backdrop artwork and photos shown over the home screen."
 ],
 "com.google.android.ext.services": [
  "keep",
  "Android extension services that GMS components lean on."
 ],
 "com.google.android.ext.shared": [
  "keep",
  "Shared library that GMS components link against."
 ],
 "com.google.android.feedback": [
  "bloat",
  "Sends usage crash/feedback reports."
 ],
 "com.google.android.gms": [
  "keep",
  "Play Services — almost every streaming app depends on it."
 ],
 "com.google.android.gsf": [
  "keep",
  "Google Services Framework — sign-in and Play registration depend on it."
 ],
 "com.google.android.inputmethod.latin": [
  "keep",
  "On-screen keyboard; without it you cannot type a Wi-Fi password."
 ],
 "com.google.android.katniss": [
  "careful",
  "Google voice search / Assistant for TV."
 ],
 "com.google.android.marvin.talkback": [
  "bloat",
  "VoiceOver-style screen reader for accessibility."
 ],
 "com.google.android.modulemetadata": [
  "keep",
  "Declares GMS updatable-module metadata to the framework."
 ],
 "com.google.android.onetimeinitializer": [
  "bloat",
  "Runs once at first boot to seed other apps."
 ],
 "com.google.android.overlay.googlewebview": [
  "keep",
  "Overlay pointing WebView intents at Google's WebView implementation."
 ],
 "com.google.android.overlay.gtvsconfigx": [
  "careful",
  "Google TV SConfigX overlay — system configuration values."
 ],
 "com.google.android.overlay.gtvssettingsprovider": [
  "careful",
  "Google TV settings-provider overlay (TvProvider config)."
 ],
 "com.google.android.overlay.modules.ext.services": [
  "bloat",
  "Overlay redirecting extension-service config; disabling only rewires defaults."
 ],
 "com.google.android.overlay.modules.modulemetadata.forframework": [
  "keep",
  "Overlay declaring updatable-module metadata to the framework."
 ],
 "com.google.android.overlay.modules.permissioncontroller": [
  "keep",
  "Overlay pointing the framework at Google's permission UI."
 ],
 "com.google.android.overlay.modules.permissioncontroller.forframework": [
  "keep",
  "Same permission-UI overlay, applied to the framework package."
 ],
 "com.google.android.packageinstaller": [
  "keep",
  "Installs APKs; disabling it breaks installs."
 ],
 "com.google.android.partnersetup": [
  "bloat",
  "Pushes partner/bookmark configuration to the device."
 ],
 "com.google.android.permissioncontroller": [
  "keep",
  "Runtime permission dialogs."
 ],
 "com.google.android.play.games": [
  "bloat",
  "Play Games services."
 ],
 "com.google.android.safetycenter.resources": [
  "keep",
  "Overlay of Safety Center resources (app security warnings)."
 ],
 "com.google.android.syncadapters.calendar": [
  "bloat",
  "Calendar sync; nothing on a TV schedules calendar."
 ],
 "com.google.android.tts": [
  "careful",
  "Speech engine for Assistant and TalkBack; losing it silences voice replies."
 ],
 "com.google.android.tungsten.setupwraith": [
  "careful",
  "Out-of-box setup wizard; disabling after first boot is usually fine."
 ],
 "com.google.android.tv.axel": [
  "keep",
  "AtvAxel — the IR-blaster/Magic remote setup wizard and remote config receivers."
 ],
 "com.google.android.tv.dfuservice": [
  "careful",
  "Persistent Google TV system app sharing GMS's signature; 'DFU' is its name, not a proven function."
 ],
 "com.google.android.tv.frameworkpackagestubs": [
  "careful",
  "Stubs GMS routes framework intents through; breaks sign-in UI on some builds."
 ],
 "com.google.android.tv.remote.service": [
  "keep",
  "Phone-as-remote and remote pairing service — looks like bloat, is not."
 ],
 "com.google.android.tv.settings.energymodes.resoverlay": [
  "careful",
  "Google TV Settings energy-modes resoverlay."
 ],
 "com.google.android.webview": [
  "keep",
  "Chrome WebView back-end for in-app web pages; GMS updatable."
 ],
 "com.google.android.youtube.tv": [
  "careful",
  "YouTube for TV; the remote's dedicated YouTube key stops working."
 ],
 "com.google.android.youtube.tvmusic": [
  "bloat",
  "YouTube Music for TV."
 ],
 "com.gretzky.GlobalKey": [
  "careful",
  "Vendor GlobalReceiver for GLOBAL_BUTTON broadcasts; which keys, undocumented."
 ],
 "com.netflix.ninja": [
  "keep",
  "Netflix for TV, installed from Play; sideloading or disabling it breaks the remote's Netflix key."
 ],
 "com.netflix.tokenmanager": [
  "keep",
  "Netflix device-token helper installed alongside Netflix; disabling it signs the box out."
 ],
 "com.onn.bluetoothconnect": [
  "careful",
  "BtRemoteSetupWizard — Bluetooth remote setup hooked into the first-boot wizard."
 ],
 "com.onn.btpairoverlay": [
  "careful",
  "Brand overlay on the Bluetooth remote setup wizard."
 ],
 "com.onn.slices.ext.res.overlay": [
  "careful",
  "Brand overlay on the slice provider's CEC extension."
 ],
 "com.onn.slices.res.overlay": [
  "careful",
  "Brand overlay on the TV Settings slice provider."
 ],
 "com.onn.updatenotification": [
  "bloat",
  "UpdateNotification — persistent boot receiver that posts the system-update nag."
 ],
 "com.realtek.android.tv.googletvconnecteddevices": [
  "careful",
  "Connected-devices screen and Bluetooth device profile services."
 ],
 "com.realtek.atv.axel.overlay": [
  "careful",
  "Rewrites TV Settings resources; the axel in its name is not the target."
 ],
 "com.realtek.gsi.tethering.overlay": [
  "careful",
  "Overlay on the tethering network stack's resources."
 ],
 "com.realtek.slices": [
  "careful",
  "Settings-Slices provider behind TV Settings pages (video, screensaver, hotspot, advanced)."
 ],
 "com.realtek.slices.ext": [
  "careful",
  "Settings-Slices extension carrying the CEC options page."
 ],
 "com.realtek.slices.tv.resoverlay": [
  "careful",
  "Overlay on the TV Settings slice provider."
 ],
 "com.realtek.tethering.overlay": [
  "careful",
  "Installed but not enabled in the device's overlay list — inert as it stands."
 ],
 "com.realtek.ui_1080.frameworkoverlay": [
  "careful",
  "Framework overlay carrying Realtek's 1080 UI config."
 ],
 "com.realtek.wifi.resources.overlay": [
  "careful",
  "Realtek Wi-Fi resource overlay."
 ],
 "com.sdapp.axeloverlay": [
  "careful",
  "AXEL app-layer overlay (app recommendations/connections)."
 ],
 "com.smartdevice.tv.aircast": [
  "bloat",
  "Casting receiver installed from Play (version name ends -airplay); no system role."
 ],
 "rtk.axel.overlay": [
  "careful",
  "AXEL app-framework overlay — app layer config."
 ]
};
