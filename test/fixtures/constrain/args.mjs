// Prints the arguments it was given, as a .cmd file passes them on through cmd.exe: all of them through %* (args.cmd),
// or the first as "%~1" (first.cmd).
console.log(`ARGS ${JSON.stringify(process.argv.slice(2))}`);
