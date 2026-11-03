# Components and provenance

Target game: The Binding of Isaac: Repentance 1.7.9b.J835.

This local package contains game-derived WebAssembly and resources copied from the user's existing installation. Original game and mod copyrights remain with their respective owners. The launcher and browser adapter do not change those ownerships.

- J835 recompiler/runtime: https://github.com/0xl0cal/repentogxm at 8f931dd1f22ad866ea7e3311407d4a4522991ee3. Upstream GPL-2.0-or-later notice is retained in licenses/repentogxm-LICENSE.
- Emscripten 6.0.5, compiler revision 1db513782be24469589d7cb8a1f1834e9a33f271. MIT / University of Illinois-NCSA notices retained in licenses/Emscripten-LICENSE.
- Lua 5.3.3, unmodified library source: https://www.lua.org/ftp/lua-5.3.3.tar.gz. MIT notice retained at the end of licenses/Lua-lua.h.
- musl formatting code, libdeflate and stb_vorbis notices are retained under licenses/.
- Go 1.27.3 standard-library launcher: https://go.dev/dl/. Go BSD-style notice retained in licenses/Go-LICENSE. Launcher source is maintained in the development workspace under portable/launcher/.
- No Mods are preinstalled. Player-imported Mods retain their original authorship and notices. EID and GoodTrip are used only as separate compatibility test cases.

The original prepared PE input has SHA-256 31846486979cfa07c8c968221553052c3ff603518681ca11912d445f96ca9404. The asset manifest records the actual copied file hashes. The initial development folder contains no Steam account files, browser profiles, cookies, personal saves or development toolchains. Once played, the user-data folder contains the player's saves and imported Mods.
