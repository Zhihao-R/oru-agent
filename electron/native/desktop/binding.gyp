{
  "targets": [
    {
      "target_name": "desktop_native",
      "sources": ["desktop_native.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "libraries": [
        "-framework Cocoa",
        "-framework CoreGraphics",
        "-framework ApplicationServices"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
      }
    }
  ]
}
