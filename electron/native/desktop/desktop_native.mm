// 唤起对话的 macOS native 三合一之二/三（技术设计 §11 / §12 风险 3、10）——
// uiohook 全局触发是现成 npm 包（trigger.ts），这里实现 Electron 无 API 的两块：
//   1. windowOwnerAtPoint：CGWindowListCopyWindowInfo 做真 window-at-point 分流 hit-test（风险 10）。
//      active-win 只给 frontmost，主窗被遮挡时判错 → 点了没反应；这里取「该点最上层普通窗」的真归属。
//   2. makeKeyNonactivating：把承载窗的 NSPanel 设 nonactivating + makeKeyAndOrderFront（风险 3），
//      实现「弹出即打字、不打断背后」——单独拿键盘焦点、不激活 app。
//
// N-API（node-addon-api）封装；须按 Electron 的 ABI 编译（见 scripts/buildNative.mjs）。
// AppKit 调用都在主进程 JS 线程 = app 主线程，满足 AppKit「主线程」约束。
#include <napi.h>
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

// windowOwnerAtPoint(x, y) -> { pid: number, app: string } | null
// 入参是 DIP / 左上原点全局点（uiohook 同系，§4 实测）；CGWindowBounds 是 points / 左上全局，同系可直接比。
static Napi::Value WindowOwnerAtPoint(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) return env.Null();
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();

  // onScreenOnly + 排除桌面元素；返回数组按前到后（front-to-back）排序——第一个命中的就是最上层。
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!windows) return env.Null();

  Napi::Value result = env.Null();
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex i = 0; i < count; i++) {
    CFDictionaryRef win = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);

    // 只认 layer 0 普通窗口；跳过菜单栏 / Dock / 状态栏等高 layer（它们不是「用户指的那块内容」）
    CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowLayer);
    int layer = 0;
    if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
    if (layer != 0) continue;

    CFDictionaryRef boundsDict = (CFDictionaryRef)CFDictionaryGetValue(win, kCGWindowBounds);
    if (!boundsDict) continue;
    CGRect bounds;
    if (!CGRectMakeWithDictionaryRepresentation(boundsDict, &bounds)) continue;
    if (!CGRectContainsPoint(bounds, CGPointMake(x, y))) continue;

    // 命中最上层普通窗：取 owner pid + name 即归属
    int pid = 0;
    CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowOwnerPID);
    if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &pid);

    std::string app;
    CFStringRef nameRef = (CFStringRef)CFDictionaryGetValue(win, kCGWindowOwnerName);
    if (nameRef) {
      char buf[256];
      if (CFStringGetCString(nameRef, buf, sizeof(buf), kCFStringEncodingUTF8)) app = buf;
    }

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("pid", Napi::Number::New(env, pid));
    obj.Set("app", Napi::String::New(env, app));
    result = obj;
    break; // 前到后第一个命中即最上层，停
  }
  CFRelease(windows);
  return result;
}

// makeKeyNonactivating(handle: Buffer<NSView*>) -> void
// handle = BrowserWindow.getNativeWindowHandle()（macOS 下即 NSView* 指针的 8 字节）。
static Napi::Value MakeKeyNonactivating(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) return env.Undefined();
  // 按字节显式校验（getNativeWindowHandle 在 macOS 下是 sizeof(NSView*) 字节的指针 Buffer）——
  // 不依赖 Buffer<void*>::Length() 的整数除法巧合
  Napi::Buffer<uint8_t> handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() < sizeof(NSView*)) return env.Undefined();

  NSView* view = *reinterpret_cast<NSView**>(handle.Data());
  NSWindow* window = [view window];
  if (!window) return env.Undefined();

  // Electron type:'panel' 造的 ElectronNSPanel 不是真 NSPanel 子类（实测 isKindOfClass:NSPanel=0），
  // nonactivating 豁免不生效——实测：拿键盘焦点（makeKeyWindow → 可打字）必然伴随 app 激活
  // （isKey=1 ⇒ appActive=1）。只 orderFrontRegardless 不 makeKey 则 isKey=0/不激活但不能打字。
  // 取「弹出即可打字」一档：menu bar 切到 Oru，但只 order 本浮层、不动主窗，背后 app 窗仍可见
  // （Spotlight/Alfred 同形态）。这与设计否决的 app.focus({steal}) 不同——后者把主窗抢前台。
  [window setStyleMask:[window styleMask] | NSWindowStyleMaskNonactivatingPanel];
  [window setHidesOnDeactivate:NO];
  [window orderFrontRegardless]; // 只 order 本浮层，不动主窗
  [window makeKeyWindow]; // 拿键盘焦点（伴随 app 激活，见上）
  return env.Undefined();
}

// activateApp(pid) -> void
// 把前台还给指定 app（关浮层后切回用户原来在用的那个）——浮层让 Oru 激活了键盘焦点，
// 关掉时用它把焦点交还，免得菜单栏/键盘卡在 Oru（「弹出即打字」方案的收尾，用户已定）。
static Napi::Value ActivateApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Undefined();
  pid_t pid = (pid_t)info[0].As<Napi::Number>().Int32Value();
  NSRunningApplication* target = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (target) [target activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  return env.Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("windowOwnerAtPoint", Napi::Function::New(env, WindowOwnerAtPoint));
  exports.Set("makeKeyNonactivating", Napi::Function::New(env, MakeKeyNonactivating));
  exports.Set("activateApp", Napi::Function::New(env, ActivateApp));
  return exports;
}

NODE_API_MODULE(desktop_native, Init)
