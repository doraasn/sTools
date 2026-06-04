# -*- mode: python ; coding: utf-8 -*-
"""
dTools PyInstaller 打包配置
构建命令: pyinstaller build.spec
输出: dist/dTools.exe
"""

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('modules/*.py', 'modules'),
        ('templates/*.html', 'templates'),
        ('static/**/*', 'static'),
    ],
    hiddenimports=['mysql.connector'],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'test', 'unittest', 'email', 'http.server'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='dTools',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,       # 控制台模式用于显示 banner + 按键监听
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
