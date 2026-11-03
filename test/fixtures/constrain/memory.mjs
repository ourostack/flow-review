// Asks for far more memory than the cap allows, a little at a time, touching every page.
const held = [];
for (let i = 0; i < 20; i++) {
  held.push(Buffer.alloc(32 * 1024 * 1024, 1));
  await new Promise((r) => setTimeout(r, 150));
}
console.log(`held ${held.length * 32} MB`);
