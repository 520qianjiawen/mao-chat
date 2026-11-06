#!/bin/bash

# Build script for Mao Virtual Audio driver
# Based on BlackHole official documentation

set -e

echo "================================"
echo "  Building Mao Virtual Audio Driver"
echo "================================"
echo ""

# Configuration
DRIVER_NAME="MaoVirtualAudio"
BUNDLE_ID="com.mao.virtualaudio"
ICON="Mao.icns"
DEVICE_NAME="MaoVirtualAudio"
CHANNELS=2

# Ensure BlackHole source exists
if [ ! -d "BlackHole" ]; then
    echo "Cloning BlackHole source repository..."
    git clone --depth 1 https://github.com/ExistentialAudio/BlackHole.git
fi

# Copy icon to BlackHole source directory
cp assets/icon.icns BlackHole/Mao.icns
echo "  Using Mao.icns as driver icon"

# Navigate to BlackHole directory
cd BlackHole

# Clean previous builds
echo "Cleaning previous builds..."
xcodebuild clean -quiet || true
rm -rf build/

# Build the driver
echo "Building driver with custom configuration..."
echo "  Driver Name: $DRIVER_NAME"
echo "  Bundle ID: $BUNDLE_ID"
echo "  Device Name: $DEVICE_NAME"
echo "  Channels: $CHANNELS"
echo ""

xcodebuild \
  -project BlackHole.xcodeproj \
  -configuration Release \
  -quiet \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  DEVELOPMENT_TEAM="" \
  MACOSX_DEPLOYMENT_TARGET=12.0 \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  PRODUCT_NAME="MaoVirtualAudio" \
  GCC_PREPROCESSOR_DEFINITIONS="\$GCC_PREPROCESSOR_DEFINITIONS kDriver_Name=\\\"${DRIVER_NAME}\\\" kPlugIn_BundleID=\\\"${BUNDLE_ID}\\\" kPlugIn_Icon=\\\"${ICON}\\\" kDevice_Name=\\\"${DEVICE_NAME}\\\" kNumber_Of_Channels=${CHANNELS}"

echo "Build completed!"
echo ""

# Check if build was successful
if [ -d "build/Release/MaoVirtualAudio.driver" ]; then
    echo "✅ Driver built successfully"

    mkdir -p ../resources/drivers
    rm -rf ../resources/drivers/MaoVirtualAudio.driver
    cp -R build/Release/MaoVirtualAudio.driver ../resources/drivers/MaoVirtualAudio.driver

    rm -f ../resources/drivers/MaoVirtualAudio.driver/Contents/Resources/BlackHole.icns
    cp ../assets/icon.icns ../resources/drivers/MaoVirtualAudio.driver/Contents/Resources/Mao.icns

    PLIST_FILE="../resources/drivers/MaoVirtualAudio.driver/Contents/Info.plist"
    if [ -f "$PLIST_FILE" ]; then
        /usr/libexec/PlistBuddy -c "Set :CFBundleName 'MaoVirtualAudio'" "$PLIST_FILE" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable 'MaoVirtualAudio'" "$PLIST_FILE" 2>/dev/null || true

        MAO_UUID="c912ea4a-d4fe-4dc1-b02c-1fe0bc45f87b"

        /usr/libexec/PlistBuddy -c "Delete :CFPlugInFactories:e395c745-4eea-4d94-bb92-46224221047c" "$PLIST_FILE" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Add :CFPlugInFactories:$MAO_UUID string BlackHole_Create" "$PLIST_FILE" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Set :CFPlugInTypes:443ABAB8-E7B3-491A-B985-BEB9187030DB:0 $MAO_UUID" "$PLIST_FILE" 2>/dev/null || true

        echo "  Updated plugin UUID to avoid conflicts with BlackHole"
    fi

    echo "✅ Driver copied to resources/drivers/MaoVirtualAudio.driver"
    ls -la ../resources/drivers/MaoVirtualAudio.driver/Contents/MacOS/
else
    echo "❌ Build failed - driver not found"
    exit 1
fi

cd ..
rm -f BlackHole/Mao.icns
echo "Done!"
