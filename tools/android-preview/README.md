# Android preview build

Builds the preview app (`com.t3tools.t3code.preview`) that runs on our phones, from any ref of this fork, and installs it.

```sh
# on the PC
SHA=$(git ls-remote https://github.com/gils-studio/t3code.git main | cut -f1)   # raw.githubusercontent caches branch URLs for minutes
fleet job start pop-os --name t3-apk -- "curl -fsSL https://raw.githubusercontent.com/gils-studio/t3code/$SHA/tools/android-preview/build.sh -o /tmp/t3-apk-build.sh && bash /tmp/t3-apk-build.sh $SHA"
fleet job wait t3-apk --until 'APK /' --timeout 1h   # about 25 minutes; prints APK <path>
fleet pull pop-os t3code-apk-out t3-preview-<sha>.apk --to ~/Downloads/t3-apk
fleet phone install s23-gerrit ~/Downloads/t3-apk/t3-preview-<sha>.apk
fleet phone install s25-nils   ~/Downloads/t3-apk/t3-preview-<sha>.apk
```

- Linux nodes only. On Windows the React Native build fails on MAX_PATH.
- The work tree is `~/fleet/work/t3code-apk`. It is kept between builds, so `node_modules` and Gradle caches are reused. Other builds should not share it.
- The APK is signed with Expo's prebuild debug keystore, the same key as the installed app. The script refuses an APK with a different signer, because installing it would force an uninstall and wipe the app's data.
- `fleet phone install` waits while the app is open on a personal phone, or the phone is away, and installs it later.
- Node 24 and JDK 17 come from `~/fleet/tools/node24` and `~/fleet-tools/jdk-17.0.21+9`; override with `T3_APK_NODE_BIN` and `T3_APK_JAVA_HOME`.
