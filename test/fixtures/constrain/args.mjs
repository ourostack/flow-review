// Prints the arguments it was given, as a .cmd file (args.cmd) passes them on through cmd.exe.
console.log(`ARGS ${JSON.stringify(process.argv.slice(2))}`);
