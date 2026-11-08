# 理序 · Cairn 手机壳应用（APK）

一个极简 WebView 壳：指向你自己的理序服务器，不打包任何网页资源——页面、逻辑、数据全在你的服务器上，APK 只是门。

## 安装到手机

1. 确认电脑上理序服务在跑（`npm run dev`），启动横幅会打印局域网地址（形如 `http://192.168.x.x:8792`）。
2. 把 `dist/cairn-mobile-debug.apk` 传到手机（微信文件传输/QQ/数据线均可），点开安装（允许「未知来源」——这是自己签名的自用包）。
3. 首次启动会弹出服务器地址（已预填上次用的），改成终端里打印的那个，点「连接」。
4. 进去后第一次到「系统设置」确认连接测试通过，就能正常用了。

## 换服务器地址

长按返回键退出重进不会重问；连不上时会有原生错误页，里面带「换个服务器地址」按钮。

## 重新构建

依赖：JDK 11+（机器上已有 Temurin 25）+ Android SDK 的 `build-tools;36.0.0` 与 `platforms;android-36`（机器上 `D:\Apps\AndroidSdk` 已具备）。

```bash
# 在 android/ 目录下：
SDK="D:/Apps/AndroidSdk"; BT="$SDK/build-tools/36.0.0"; PLAT="$SDK/platforms/android-36/android.jar"

"$BT/aapt2.exe" compile --dir res -o build/res.zip
"$BT/aapt2.exe" link -o build/base.apk -I "$PLAT" --manifest AndroidManifest.xml --java build/gen \
  --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name "1.0" --auto-add-overlay build/res.zip
javac --release 11 -classpath "$PLAT" -d build/classes build/gen/com/cairn/app/R.java src/com/cairn/app/MainActivity.java
"$BT/d8.bat" --release --lib "$PLAT" --output build build/classes/com/cairn/app/*.class
python - <<'EOF'
import zipfile
zin = zipfile.ZipFile('build/base.apk')
zout = zipfile.ZipFile('build/unsigned.apk', 'w', zipfile.ZIP_DEFLATED)
for i in zin.infolist():
    ct = zipfile.ZIP_STORED if i.filename == 'resources.arsc' else i.compress_type
    zout.writestr(i.filename, zin.read(i.filename), compress_type=ct)
zout.writestr('classes.dex', open('build/classes.dex', 'rb').read())
zout.close()
EOF
"$BT/zipalign.exe" -f 4 build/unsigned.apk build/aligned.apk
"$BT/apksigner.bat" sign --ks cairn-debug.keystore --ks-pass pass:cairn2026 --key-pass pass:cairn2026 \
  --out dist/cairn-mobile-debug.apk build/aligned.apk
```

## 注意

- 当前版本 v1.2 (versionCode 3)：三帧结构（设置 / WebView / 错误页叠放，任何时刻至少一帧可见，杜绝纯背景）；对话框彻底废除，服务器地址改为原生设置帧；崩溃留痕页优先级最高——启动即崩也能看到崩溃栈（截图发回排障）；WebView 懒创建。
- 历史：v1.1 修首启对话框崩溃（`setBackgroundDrawableResource` 误用颜色值）。
- 默认地址 `DEFAULT_SERVER` 写在 `src/com/cairn/app/MainActivity.java`，改完重跑管线即可。
- 签名用的是自建 debug 证书（`cairn-debug.keystore`），升级重装时**必须用同一个 keystore**，否则要卸载重装。
- 局域网 http 为明文，`usesCleartextTraffic=true` 已放行；账目不出你的局域网。
- 要在外网用：给服务器套 HTTPS（如内网穿透 + 域名证书），APK 里填 https 地址即可。
