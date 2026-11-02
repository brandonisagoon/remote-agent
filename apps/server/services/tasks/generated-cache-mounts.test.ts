import { expect, test } from "bun:test";
import { cacheMountpoints } from "./generated-cache-mounts.ts";
test("reads complete Darwin and Linux mount inventories, preserving escaped spaces", () => {
 expect(cacheMountpoints('/dev/root on / (apfs, local)\nvolume on /private/task/cache\\040files (bind, local)\n','darwin')).toEqual(['/','/private/task/cache files']);
 expect(cacheMountpoints('1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /data /private/task rw - ext4 /dev/root rw\n','linux')).toEqual(['/','/private/task']);
});
test.each(['','denied','volume on /private/task (local)\n','x on / (apfs)\ny on /task on /ambiguous (bind)'])('refuses incomplete or ambiguous inventory: %s', text => {
 expect(() => cacheMountpoints(text,'darwin')).toThrow();
});
