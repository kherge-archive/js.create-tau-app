#!/usr/bin/env node

"use strict";

const chalk = require("chalk");
const config = require("./package.json");
const decompress = require("decompress");
const download = require("download");
const fs = require("fs");
const jsonfile = require("jsonfile");
const move = require("move-concurrently");
const os = require("os");
const path = require("path");
const prompt = require("prompt");
const semver = require("semver");
const { Command, InvalidOptionArgumentError } = require("commander");
const { Octokit } = require("@octokit/core");

/**
 * The GitHub download URL template.
 */
const DOWNLOAD_URL =
  "https://github.com/kherge/js.tau/archive/refs/tags/{}.zip";

/**
 * The path to the downloaded releases directory.
 */
const DOWNLOADS = path.join(os.homedir(), "/.config/create-tau-app/releases");

/**
 * The name for the latest version.
 */
const LATEST = "latest";

/**
 * Exits with an error message.
 *
 * @param code    The status code.
 * @param message The error message.
 */
const exit = (code, message) => {
  console.error(chalk.red(message));
  process.exit(code);
};

/**
 * Downloads the release and returns the downloaded file's path.
 *
 * @param version The release version.
 * @param url     The release download URL.
 *
 * @return The file path.
 */
const downloadRelease = async (version, url) => {
  // Create the download directory if it does not exist.
  if (!fs.existsSync(DOWNLOADS)) {
    fs.mkdirSync(DOWNLOADS, {
      recursive: true,
    });
  }

  // Download the file.
  const filePath = path.join(DOWNLOADS, `${version}.zip`);

  if (!fs.existsSync(filePath)) {
    await download(url, DOWNLOADS, {
      filename: `${version}.zip`,
    });
  }

  return filePath;
};

/**
 * Returns the available releases.
 *
 * @return The releases.
 */
const getReleases = async () => {
  // Get the list of releases from GitHub.
  const client = new Octokit();
  const releases = {};
  const result = await client.request(
    "GET /repos/kherge/js.tau/releases?per_page=100"
  );

  // Generate download URLs for each release.
  for (const release of result.data) {
    if (
      release.draft ||
      release.prerelease ||
      !semver.valid(release.tag_name)
    ) {
      continue;
    }

    releases[release.tag_name] = DOWNLOAD_URL.replace("{}", release.tag_name);
  }

  // Identify the most recent release.
  const current = Object.keys(releases).sort((a, b) => {
    if (semver.lt(a, b)) {
      return 1;
    } else if (semver.gt(a, b)) {
      return -1;
    }

    return 0;
  })[0];

  releases[LATEST] = releases[current];

  return releases;
};

/**
 * Replaces package.json information with data provided by user prompts.
 *
 * @param file The path to the package.json file.
 */
const replacePackageInfo = (file) => {
  const schema = {
    properties: {
      author: {
        description: "Package Author",
      },
      description: {
        description: "Package Description",
      },
      name: {
        description: "Package Name",
      },
    },
  };

  prompt.start();
  prompt.get(schema, (error, result) => {
    if (!error) {
      const info = jsonfile.readFileSync(file);

      info.author = result.author;
      info.description = result.description;
      info.name = result.name;

      jsonfile.writeFileSync(file, info, { spaces: 2 });
    }
  });
};

/**
 * Decompresses the downloaded release to the specified directory.
 *
 * @param file The release file path.
 * @param dir  The target directory.
 */
const unpackRelease = async (file, dir) => {
  // Archive contains a directory, so decompress somewhere else.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cta-"));
  const result = await decompress(file, tempDir);

  // Move the inner directory to where the user wants it.
  const innerDir = path.join(tempDir, path.basename(result[0].path));

  await move(innerDir, dir).catch((error) => {
    exit(1, error);
  });
};

// Create the command using the package name.
const command = new Command(config.name);

// Configure the command.
command
  .version(config.version)
  .arguments("<dir>")
  .usage(`${chalk.green("<dir>")} [OPTIONS]`)
  .option(
    "-t, --template-version <version>",
    "The version of the template to use.",
    (value) => {
      if (!semver.valid(value)) {
        throw new InvalidOptionArgumentError(
          "A semantic version number is required."
        );
      }

      return value;
    }
  );

// Set the actual work.
command.action(async (dir) => {
  // Make sure the directory doesn't already exist.
  if (fs.existsSync(dir)) {
    exit(1, "The target directory already exists.");
  }

  // Get the available releases.
  console.log("Getting releases...");

  const releases = await getReleases();

  // Make sure the desired release exists.
  const version = command.opts()["template-version"] ?? "latest";

  if (!releases[version]) {
    exit(1, `The specified template version, ${version}, does not exist.`);
  }

  // Download the archive for the release.
  console.log("Downloading release...");

  const filePath = await downloadRelease(version, releases[version]);

  // Unpack the archive to the directory.
  console.log("Unpacking release...");

  await unpackRelease(filePath, dir);

  // Replace package information.
  replacePackageInfo(path.join(dir, "package.json"));
});

// Run the command.
command.parseAsync(); /*.catch((error) => {
  exit(1, error);
});*/
