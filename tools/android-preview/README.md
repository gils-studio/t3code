# Android preview build

Builds the preview app (`com.t3tools.t3code.preview`) that runs on our phones, from any ref of this fork, and installs it.

```sh
# on the PC
fleet job start pop-os --name t3-apk -- 'bash <(curl -fsSL https://raw.githubusercontent.com/gils-studio/t3code/main/tools/android-preview/build.sh) main'
fleet job wait t3-apk --timeout 1h        # last log line: APK <path>
fleet pull pop-os <path> --to ~/Downloads
fleet phone install s23-gerrit ~/Downloads/t3-preview-<sha>.apk
fleet phone install s25-nils   ~/Downloads/t3-preview-<sha>.apk
```

- Linux nodes only. On Windows the React Native build fails on MAX_PATH.
- The work tree is `~/fleet/work/t3code-apk`. It is kept between builds, so `node_modules` and Gradle caches are reused. Other builds should not share it.
- The APK is signed with Expo's prebuild debug keystore, the same key as the installed app. The script refuses an APK with a different signer, because installing it would force an uninstall and wipe the app's data.
- `fleet phone install` waits while the app is open on a personal phone and installs it later.
