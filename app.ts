import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";

const execAsync = promisify(exec);

// -------------------------
// Type definitions
// -------------------------
// Unified option value class for encoders, protocols, and filters
class OptionValue {
  constructor(
    public name: string = "",
    public value: number | string = "",
    public flags: string = "",
    public description: string = ""
  ) {}
}

// Unified option class with flexible attributes
class Option {
  values: OptionValue[] = [];
  default?: boolean | number | string;
  min?: string;
  max?: string;

  constructor(
    public name: string = "",
    public type: string = "",
    public flags: string = "",
    public description: string = ""
  ) {}
}

class Encoder {
  pixelFormats: string[] = [];
  options: Option[] = [];
  fullHelp?: string;

  constructor(
    public name: string = "",
    public description: string = "",
    public generalCapabilities: string = "",
    public threading: string = "",
    public flags?: string
  ) {}
}

class Protocol {
  options: Option[] = [];

  constructor(
    public name: string = "",
    public direction: string = "",
    public fullHelp?: string
  ) {}
}

class Format {
  options: Option[] = [];

  constructor(
    public flags: string = "",
    public name: string = "",
    public description: string = "",
    public canDemux: boolean = false,
    public canMux: boolean = false,
    public isDevice: boolean = false,
    public fullHelp?: string
  ) {}
}

class FilterPad {
  constructor(
    public id: string = "",
    public label: string = "",
    public type: string = ""
  ) {}
}

class Filter {
  inputs: FilterPad[] = [];
  outputs: FilterPad[] = [];
  options: Option[] = [];

  constructor(
    public flags: string = "",
    public name: string = "",
    public description: string = "",
    public fullHelp?: string
  ) {}
}

interface FFmpegCapabilities {
  protocols: Protocol[];
  demuxers: Format[];
  muxers: Format[];
  filters: Filter[];
  encoders: Encoder[];
}

// -------------------------
// Run FFmpeg command
// -------------------------
async function runFFmpeg(args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `ffmpeg -hide_banner -loglevel error ${args}`,
      { maxBuffer: 1024 * 1024 * 10 }
    );
    return stdout;
  } catch (err) {
    // ffmpeg -h sometimes returns exit code 1 or 255 but still prints help
    const error = err as any;
    return error.stdout || "";
  }
}

async function runLimitedParallel<T, R>(
  items: T[],
  limit: number,
  workerFn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  return new Promise((resolve, reject) => {
    let active = 0;

    function launchNext(): void {
      while (active < limit && index < items.length) {
        const i = index++;
        active++;

        Promise.resolve(workerFn(items[i], i))
          .then((result: R) => {
            results[i] = result;
          })
          .catch((err: any) => {
            // skip on error
          })
          .finally(() => {
            active--;
            if (index === items.length && active === 0) {
              resolve(results);
            } else {
              launchNext();
            }
          });
      }
    }

    launchNext();
  });
}

// -------------------------
// Parse section list
// -------------------------
function parseFlagsNameDesc(output: string, sectionHeading: string): Filter[] {
  const start = output.indexOf(sectionHeading);
  if (start === -1) return [];

  const lines = output
    .slice(start)
    .split("\n")
    .slice(1);

  const items: Filter[] = [];

  for (const line of lines) {
    const t = line.trim();

    // Stop if a new section starts
    if (/^[A-Za-z ]+:$/.test(t)) break;
    if (!t) continue;

    // Flags, name, description
    const parts = t.split(/\s+/, 3);
    if (parts.length === 3) {
      const [flags, name, description] = parts;
      items.push(new Filter(flags, name, description));
    }
  }

  return items;
}


function parseProtocols(output: string): Protocol[] {
  const lines = output.split("\n").map((l) => l.trim());

  const sections: { Input: Protocol[]; Output: Protocol[] } = {
    Input: [],
    Output: [],
  };

  let current: "Input" | "Output" | null = null;

  for (const line of lines) {
    if (/^Input:?$/i.test(line)) {
      current = "Input";
      continue;
    }
    if (/^Output:?$/i.test(line)) {
      current = "Output";
      continue;
    }

    // Skip noise
    if (!current) continue;
    if (!line) continue;

    // protocol lines are just bare words, e.g. "http"
    const match = line.match(/^([a-zA-Z0-9_]+)$/);
    if (match) {
      sections[current].push(new Protocol(match[1], current));
    }
  }

  return sections.Input.concat(sections.Output);
}

function parseFormats(output: string): Format[] {
  const lines = output.split("\n");

  const items: Format[] = [];
  let start = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip until the actual list starts (after the flags legend)
    if (!start) {
      if (/^D\.\. = /i.test(trimmed)) continue;
      if (/^\.\.E = /i.test(trimmed)) continue;
      if (/^\.\.d = /i.test(trimmed)) continue;
      if (/^---/.test(trimmed)) {
        start = true;
      }
      continue;
    }

    if (!trimmed) continue;

    // Matches lines like:
    //   DE  aac             description
    //   D d gdigrab         description
    //   D   mov,mp4,...     description
    //
    // Captures:
    //   1 = flags (D E d .)
    //   2 = format name
    //   3 = description
    const match = trimmed.match(/^([DE\.d ]{1,3})\s+([A-Za-z0-9_,]+)\s+(.*)$/);

    if (!match) continue;

    const [, flags, name, description] = match;

    items.push(
      new Format(
        flags.trim(),
        name.trim(),
        description.trim(),
        flags.includes("D"),
        flags.includes("E"),
        flags.includes("d")
      )
    );
  }

  return items;
}

// -------------------------
// Fetch FFmpeg help text for each entry
// -------------------------
async function fetchHelp(entryName: string): Promise<string> {
  let h = await runFFmpeg(`-h ${entryName}`);
  h = h.replace(/Exiting with exit code 0/g, "");
  return h.trim();
}

async function fetchHelpForFormat(
  item: Format,
  type: string
): Promise<string> {
  // Fetch help text for the format (muxer or demuxer)
  let helpText = "";
  
  if (type === "demuxer" && item.canDemux) {
    let h = await runFFmpeg(`-h demuxer=${item.name}`);
    h = h.replace(/Exiting with exit code 0/g, "");
    helpText = h.trim();
  } else if (type === "muxer" && item.canMux) {
    let h = await runFFmpeg(`-h muxer=${item.name}`);
    h = h.replace(/Exiting with exit code 0/g, "");
    helpText = h.trim();
  }

  return helpText;
}

// -------------------------
// Parse FFmpeg encoder help
// -------------------------

async function fetchEncoderHelp(item: Filter): Promise<Encoder> {
  const helpText = await fetchHelp("encoder=" + item.name);
  return parseEncoderHelp(helpText);
}

function parseEncoderHelp(helpText: string): Encoder {
  const lines = helpText.split(/\r?\n/);
  const encoder = new Encoder("", "", "", "");

  let currentOption: Option | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Header
    const headerMatch = line.match(/^Encoder (\S+) \[(.+?)\]:$/);
    if (headerMatch) {
      encoder.name = headerMatch[1];
      encoder.description = headerMatch[2];
      continue;
    }

    if (/^General capabilities:/.test(trimmed)) {
      encoder.generalCapabilities = trimmed.replace(/^General capabilities:\s*/, "");
      continue;
    }

    if (/^Threading capabilities:/.test(trimmed)) {
      encoder.threading = trimmed.replace(/^Threading capabilities:\s*/, "");
      continue;
    }

    if (/^Supported pixel formats:/.test(trimmed)) {
      encoder.pixelFormats = trimmed
        .replace(/^Supported pixel formats:\s*/, "")
        .split(/\s+/);
      continue;
    }

    // AVOptions
    const optMatch = trimmed.match(
      /^(-\S+)\s+<([^>]+)>\s+([A-Z\.]+)\s+(.+?)(?:\(default\s*(.+?)\))?$/
    );
    if (optMatch) {
      if (currentOption) encoder.options.push(currentOption);

      const [, name, type, flags, desc, def] = optMatch;
      currentOption = new Option(name, `<${type}>`, flags, desc.trim());
      currentOption.default = def ? parseDefaultValue(def.trim()) : undefined;
      continue;
    }

    // Nested enum values (indented 5+ spaces)
    const enumMatch = trimmed.match(/^(\S+)\s+([-\d.]+)\s+([A-Z\.]+)\s*(.*)$/);
    if (currentOption && line.startsWith("     ") && enumMatch) {
      const [_, name, value, flags, desc] = enumMatch;
      currentOption.values.push(
        new OptionValue(name, parseFloat(value) || value, flags, desc.trim())
      );
      continue;
    }

    // Multi-line description
    if (currentOption && line.startsWith("        ")) {
      currentOption.description += " " + trimmed;
      continue;
    }
  }

  if (currentOption) encoder.options.push(currentOption);
  return encoder;
}

function parseDefaultValue(val: string): boolean | number | string {
  if (val === "true") return true;
  if (val === "false") return false;
  if (!isNaN(Number(val))) return parseFloat(val);
  return val;
}

// -------------------------
// Parse FFmpeg protocol help
// -------------------------
function parseProtocolHelp(helpText: string): Protocol {
  const lines = helpText.split(/\r?\n/);
  const protocol = new Protocol("", "", helpText);

  let currentOption: Option | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Extract protocol name from "<name> AVOptions:" line
    const protoMatch = trimmed.match(/^(\w+)\s+AVOptions:/);
    if (protoMatch) {
      protocol.name = protoMatch[1];
      continue;
    }

    // Parse option line: "   name              <type>        flags description"
    const optMatch = line.match(/^\s+(\S+)\s+<([^>]+)>\s+(\S+)\s+(.+)$/);
    if (optMatch) {
      if (currentOption) protocol.options.push(currentOption);

      const [, name, type, flags, desc] = optMatch;
      const defaultMatch = desc.match(/\(.*?default\s+([^)]+)\)/);
      const rangeMatch = desc.match(/\(from\s+(-?[\w.]+)\s+to\s+(-?[\w.]+)\)/);

      currentOption = new Option(name.trim(), `<${type}>`, flags.trim(), desc.trim());

      if (defaultMatch && !defaultMatch[1].includes("from")) {
        currentOption.default = parseDefaultValue(defaultMatch[1].trim());
      }
      if (rangeMatch) {
        currentOption.default = parseDefaultValue(rangeMatch[1]);
      }
      continue;
    }

    // Enum values: "     none            0            description"
    if (currentOption && line.startsWith("     ") && !line.match(/^\s+\w+\s+</)) {
      const valMatch = line.trim().match(/^(\w+)\s+(\S+)\s+(.*)$/);
      if (valMatch) {
        currentOption.values.push(
          new OptionValue(
            valMatch[1],
            isNaN(Number(valMatch[2])) ? valMatch[2] : parseInt(valMatch[2]),
            "",
            valMatch[3].trim()
          )
        );
      }
      continue;
    }
  }

  if (currentOption) protocol.options.push(currentOption);
  return protocol;
}

// -------------------------
// Parse FFmpeg format (muxer/demuxer) help
// -------------------------
function parseFormatHelp(helpText: string): Format {
  const lines = helpText.split(/\r?\n/);
  const format = new Format("", "", "", false, false, false, helpText);

  let currentOption: Option | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Extract format name from "Muxer/Demuxer <name> [description]:" line
    const formatMatch = trimmed.match(/^(Muxer|Demuxer)\s+(\S+)\s+\[(.+?)\]:/);
    if (formatMatch) {
      format.name = formatMatch[2];
      format.description = formatMatch[3];
      continue;
    }

    // Find AVOptions section: "<names> muxer/demuxer AVOptions:"
    if (trimmed.match(/AVOptions:$/)) {
      // Skip to next iteration to start parsing options
      continue;
    }

    // Parse option line: "   name              <type>        flags description"
    const optMatch = line.match(/^\s+(-\w+)\s+<([^>]+)>\s+(\S+)\s+(.+)$/);
    if (optMatch) {
      if (currentOption) format.options.push(currentOption);

      const [, name, type, flags, desc] = optMatch;
      const defaultMatch = desc.match(/\(.*?default\s+([^)]+)\)/);
      const rangeMatch = desc.match(/\(from\s+(-?[\w.]+)\s+to\s+(-?[\w.]+)\)/);

      currentOption = new Option(name.trim(), `<${type}>`, flags.trim(), desc.trim());

      if (defaultMatch && !defaultMatch[1].includes("from")) {
        currentOption.default = parseDefaultValue(defaultMatch[1].trim());
      }
      if (rangeMatch) {
        currentOption.default = parseDefaultValue(rangeMatch[1]);
      }
      continue;
    }

    // Enum values: "     cmaf                         E.......... description"
    if (currentOption && line.startsWith("     ") && !line.match(/^\s+-\w+\s+</)) {
      const valMatch = line.trim().match(/^(\w+)\s+([\w.]+\s+)?(.*)$/);
      if (valMatch) {
        const name = valMatch[1];
        const flags = valMatch[2] ? valMatch[2].trim() : "";
        const description = valMatch[3].trim();
        currentOption.values.push(
          new OptionValue(name, name, flags, description)
        );
      }
      continue;
    }
  }

  if (currentOption) format.options.push(currentOption);
  return format;
}

// -------------------------
// Parse FFmpeg filter help
// -------------------------
function parseFilterHelp(helpText: string, filter: Filter): Filter {
  const lines = helpText.split(/\r?\n/);
  // const filter: Filter = {
  //   flags: "",
  //   name: "",
  //   description: "",
  //   inputs: [],
  //   outputs: [],
  //   options: [],
  //   fullHelp: helpText
  // };

  let currentSection: "description" | "inputs" | "outputs" | "options" = "description";
  let currentOption: Option | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Header: "Filter <name>"
    if (trimmed.startsWith("Filter ")) {
      filter.name = trimmed.replace(/^Filter\s+/, "").trim();
      continue;
    }

    // Section headers
    if (trimmed === "Inputs:" || trimmed.startsWith("Inputs:")) {
      currentSection = "inputs";
      continue;
    }
    if (trimmed === "Outputs:" || trimmed.startsWith("Outputs:")) {
      currentSection = "outputs";
      continue;
    }
    if (trimmed.endsWith(" AVOptions:") || trimmed.endsWith("AVOptions:")) {
      currentSection = "options";
      continue;
    }

    // Parse description (first non-empty line after Filter name)
    if (currentSection === "description" && !filter.description && trimmed && !trimmed.startsWith("slice")) {
      filter.description = trimmed;
      continue;
    }

    // Parse inputs: "    #0: input (audio)"
    if (currentSection === "inputs" && line.match(/^\s+#\d+:/)) {
      const match = line.match(/^\s+#(\d+):\s+(\w+)\s+\(([^)]+)\)/);
      if (match) {
        filter.inputs.push(new FilterPad(match[1], match[2], match[3]));
      }
      continue;
    }

    // Parse outputs: "    #0: default (audio)"
    if (currentSection === "outputs" && line.match(/^\s+#\d+:/)) {
      const match = line.match(/^\s+#(\d+):\s+(\w+)\s+\(([^)]+)\)/);
      if (match) {
        filter.outputs.push(new FilterPad(match[1], match[2], match[3]));
      }
      continue;
    }

    // Parse options
    if (currentSection === "options") {
      // Option line: "   name              <type>        flags description"
      const optMatch = line.match(/^\s+(\S+)\s+<([^>]+)>\s+(\S+)\s+(.+)$/);
      if (optMatch) {
        if (currentOption) filter.options.push(currentOption);

        const [, name, type, flags, desc] = optMatch;
        const defaultMatch = desc.match(/\(.*?default\s+([^)]+)\)/);
        const rangeMatch = desc.match(/\(from\s+(-?[\w.]+)\s+to\s+(-?[\w.]+)\)/);

        currentOption = new Option(name.trim(), `<${type}>`, flags, desc.trim());

        if (defaultMatch) {
          currentOption.default = defaultMatch[1].trim();
        }
        if (rangeMatch) {
          currentOption.min = rangeMatch[1];
          currentOption.max = rangeMatch[2];
        }
        continue;
      }

      // Enum values: "     none            0            description"
      if (currentOption && line.startsWith("     ") && !line.match(/^\s+\w+\s+</)) {
        const valMatch = line.trim().match(/^(\w+)\s+(\S+)\s+(.*)$/);
        if (valMatch) {
          currentOption.values.push(
            new OptionValue(valMatch[1], valMatch[2], "", valMatch[3].trim())
          );
        }
        continue;
      }
    }
  }

  if (currentOption) filter.options.push(currentOption);
  return filter;
}

// -------------------------
// Get all FFmpeg capabilities
// -------------------------
async function getFFmpegCapabilities(): Promise<FFmpegCapabilities> {
  console.log("Reading FFmpeg capabilities...");

  // Parse command-line arguments for skip options
  const args = process.argv.slice(2);
  const skipSet = new Set(args.map(arg => arg.toLowerCase()));
  
  // Parse limit option
  const limitArg = args.find(arg => arg.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]) : undefined;
  
  // Parse skip option (number of entries to skip)
  const skipArg = args.find(arg => arg.startsWith("--skip="));
  const skip = skipArg ? parseInt(skipArg.split("=")[1]) : 0;

  const [protocolsRaw, demuxersRaw, muxersRaw, encodersRaw, filtersRaw] =
    await Promise.all([
      skipSet.has("--skip-protocols") ? Promise.resolve("") : runFFmpeg("-protocols"),
      skipSet.has("--skip-demuxers") ? Promise.resolve("") : runFFmpeg("-demuxers"),
      skipSet.has("--skip-muxers") ? Promise.resolve("") : runFFmpeg("-muxers"),
      skipSet.has("--skip-encoders") ? Promise.resolve("") : runFFmpeg("-encoders"),
      skipSet.has("--skip-filters") ? Promise.resolve("") : runFFmpeg("-filters"),
    ]);

  const result: Partial<FFmpegCapabilities> = {};

  if (!skipSet.has("--skip-protocols")) {
    const protocols = parseProtocols(protocolsRaw).slice(skip, skip ? skip + (limit || Infinity) : limit);
    console.log(`Fetching help for ${protocols.length} protocols...`);
    const protocolHelp = await runLimitedParallel(protocols, 100, async (p) => {
      let fullHelp = await fetchHelp("protocol=" + p.name);
      // Parse detailed protocol help into structured format
      try {
        const parsed = parseProtocolHelp(fullHelp);
        p.options = parsed.options;
        p.fullHelp = parsed.fullHelp;
      } catch (e) {
        // If parsing fails, keep raw help text
        p.fullHelp = fullHelp;
      }
      return p;
    });
    result.protocols = protocols;
  }

  if (!skipSet.has("--skip-demuxers")) {
    const demuxers = parseFormats(demuxersRaw).slice(skip, skip ? skip + (limit || Infinity) : limit);
    console.log(`Fetching help for ${demuxers.length} demuxers...`);
    for (const f of demuxers) {
      let fullHelp = await fetchHelpForFormat(f, "demuxer");
      try {
        const parsed = parseFormatHelp(fullHelp);
        f.options = parsed.options;
        f.fullHelp = parsed.fullHelp;
      } catch (e) {
        f.fullHelp = fullHelp;
      }
    }
    result.demuxers = demuxers;
  }

  if (!skipSet.has("--skip-muxers")) {
    const muxers = parseFormats(muxersRaw).slice(skip, skip ? skip + (limit || Infinity) : limit);
    console.log(`Fetching help for ${muxers.length} muxers...`);
    for (const f of muxers) {
      let fullHelp = await fetchHelpForFormat(f, "muxer");
      try {
        const parsed = parseFormatHelp(fullHelp);
        f.options = parsed.options;
        f.fullHelp = parsed.fullHelp;
      } catch (e) {
        f.fullHelp = fullHelp;
      }
    }
    result.muxers = muxers;
  }

  if (!skipSet.has("--skip-encoders")) {
    const encoders = (parseFlagsNameDesc(encodersRaw, "------") as any).slice(skip, skip ? skip + (limit || Infinity) : limit);
    console.log(`Fetching help for ${encoders.length} encoders...`);
    const encoderHelp = await runLimitedParallel(encoders, 100, async (p: any) => {
      p.fullHelp = await fetchEncoderHelp(p);
      return p;
    });
    result.encoders = encoders;
  }

  if (!skipSet.has("--skip-filters")) {
    const filters = (parseFlagsNameDesc(filtersRaw, "| = Source or sink filter") as any).slice(skip, skip ? skip + (limit || Infinity) : limit);
    console.log(`Fetching help for ${filters.length} filters...`);
    const filterHelp = await runLimitedParallel(filters, 100, async (p: any) => {
      //flags,name,desc is already parsed, now fetch the rest from fullhelp
      let fullHelp = await fetchHelp("filter=" + p.name);
      p.fullHelp = fullHelp;
      // Parse detailed filter help into structured format
      try {
        parseFilterHelp(fullHelp, p);
      } catch (e) {
        // If parsing fails, keep raw help text
        p.fullHelp = fullHelp;
      }
      return p;
    });
    result.filters = filters;
  }

  return result as FFmpegCapabilities;
}

// -------------------------
// Run and output JSON
// -------------------------
getFFmpegCapabilities().then((json) => {
  //console.log(JSON.stringify(json, null, 2));
  writeFileSync(
    "C:\\dev\\node-ffmpeg-helper\\example_output.json",
    JSON.stringify(json, null, 2)
  );
});
