import { dlopen } from "bun:ffi";
import { closeSync } from "node:fs";

/** Native disposable fixtures keep bound-but-not-listening distinct from stale. */
export function fixtureSocket(file: string, state: "stale" | "bound" | "listening" | "datagram" | "stale-datagram" = "stale") {
  const mac = process.platform === "darwin";
  const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    bind: { args: ["i32", "ptr", "u32"], returns: "i32" },
    listen: { args: ["i32", "i32"], returns: "i32" },
  });
  const bytes = Buffer.from(file), address = Buffer.alloc(bytes.length + 3);
  if (bytes.length > (mac ? 103 : 107)) { library.close(); throw new Error("Fixture must bind at a short path before rename"); }
  if (mac) { address[0] = address.length; address[1] = 1; } else address.writeUInt16LE(1);
  bytes.copy(address, 2);
  let fd = library.symbols.socket(1, state.includes("datagram") ? 2 : 1, 0);
  const close = () => { if (fd >= 0) { closeSync(fd); fd = -1; } };
  try {
    if (fd < 0 || library.symbols.bind(fd, address, address.length) !== 0) throw new Error("Fixture socket bind failed");
    if (state === "listening" && library.symbols.listen(fd, 5) !== 0) throw new Error("Fixture listen failed");
    if (state.startsWith("stale")) close();
    return { close };
  } catch (error) { close(); throw error; }
  finally { library.close(); }
}
