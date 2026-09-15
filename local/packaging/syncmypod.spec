# PyInstaller build for the local app.
#
#   cd local
#   python scripts/fetch_ffmpeg.py
#   pyinstaller packaging/syncmypod.spec
#
# Two decisions shape this file.
#
# **A folder, not a single file.** PyInstaller's one-file mode unpacks the whole
# bundle into a temporary directory on every launch, and this bundle carries
# 148MB of ffmpeg - so one-file would mean a ten-second wait each time the user
# runs it, to save them seeing a folder. The folder is zipped for distribution,
# so what gets downloaded is still one file.
#
# **Submodules are collected wholesale rather than listed.** pypodlib defers
# almost every internal import into the function that needs it - `IPod.save()`
# imports the database writer, the artwork writer arrives through a module-level
# `__getattr__` - and PyInstaller's static analysis cannot see any of it. Listing
# them by hand would mean a build that works today and breaks on the next
# pypodlib release with an ImportError the user sees and cannot act on. The same
# goes for yt-dlp, whose extractors are looked up by name at runtime.

from PyInstaller.utils.hooks import collect_all, collect_submodules

BLOCK_CIPHER = None

hidden = []
binaries = []
datas = []

# pypodlib: deferred imports throughout, and a lazy __getattr__ for the artwork
# writer. Everything, because guessing is what breaks later.
hidden += collect_submodules("pypodlib")

# yt-dlp resolves extractors by name at runtime. Only the YouTube one is used
# today, but a pasted source hint can be any of the sites it supports, which is
# the entire point of accepting one.
hidden += collect_submodules("yt_dlp")

# wasmtime ships a compiled runtime and a .wasm payload as package data; mutagen
# and libusb_package carry data files of their own. collect_all takes the
# binaries and data as well as the modules.
for package in ("wasmtime", "libusb_package", "mutagen", "certifi"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hidden += package_hidden

# The GUI's page, and the ffmpeg that makes the application able to do anything.
# Both are looked for relative to the package directory at runtime, so they are
# placed where an unpacked source checkout would have them.
datas += [
    ("../src/syncmypod_local/gui/static", "syncmypod_local/gui/static"),
    ("../src/syncmypod_local/_bin", "syncmypod_local/_bin"),
]

# Both entry points in one analysis, so the dependency graph is walked once and
# the two executables share every library in the bundle.
analysis = Analysis(
    ["entry.py", "entry_windowed.py"],
    pathex=["../src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    # Nothing here draws a window of its own: the application window is a
    # Chromium browser launched with --app, so there is no toolkit to load and
    # each of these would add tens of megabytes to the download.
    #
    # pythonnet is excluded for a specific reason. pywebview pulled it in for
    # 0.1.8 and its loader could not initialise from inside a frozen bundle -
    # "Failed to resolve Python.Runtime.Loader.Initialize" - so it shipped
    # several megabytes of .NET assemblies to not work. See gui/window.py.
    excludes=[
        "tkinter",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "matplotlib",
        "IPython",
        "webview",
        "clr",
        "pythonnet",
        "clr_loader",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=BLOCK_CIPHER,
    noarchive=False,
)

pyz = PYZ(analysis.pure, analysis.zipped_data, cipher=BLOCK_CIPHER)

# Two executables, because `console` is decided per executable and the two uses
# want opposite answers.
#
# `SyncMyPod.exe` is the one people double-click. It is windowed, so there is no
# console behind the application at all - which is what 0.1.9 got wrong: it
# opened a proper window and left a terminal sitting behind it saying "Press
# Enter to close".
#
# `syncmypod-cli.exe` is the same code with a console, for `sync`,
# `check-matches` and the rest. Those print, and a windowed build has nowhere to
# print to.
#
# **The names must differ by more than case.** 0.2.0 called them `SyncMyPod` and
# `syncmypod`, which are the same filename on Windows - PyInstaller built both
# and then one overwrote the other in the output directory, so the release
# shipped with only the console build in it. The logs said both had succeeded.
console_executable = EXE(
    pyz,
    [script for script in analysis.scripts if "entry_windowed" not in script[0]],
    [],
    exclude_binaries=True,
    name="syncmypod-cli",
    # The same mark as the favicon and the page's own header, so the taskbar,
    # the window and the browser tab all show one logo.
    icon="icon.ico",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is off deliberately. It shaves some size and is one of the strongest
    # signals antivirus heuristics use to flag an unsigned executable as
    # packed malware, which is already the likeliest problem a user will hit
    # with this build.
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

windowed_executable = EXE(
    pyz,
    # The windowed script only. `analysis.scripts` holds both, and giving both
    # to both executables would make each of them run the other's entry point.
    [script for script in analysis.scripts if "entry_windowed" in script[0]],
    [],
    exclude_binaries=True,
    name="SyncMyPod",
    icon="icon.ico",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # The whole point of this second executable.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

COLLECT(
    console_executable,
    windowed_executable,
    analysis.binaries,
    analysis.zipfiles,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="syncmypod",
)
