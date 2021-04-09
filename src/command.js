"use strict";

const chalk = require("chalk");
const decompress = require("decompress");
const download = require("download");
const fs = require("fs");
const jsonfile = require("jsonfile");
const move = require("move-concurrently");
const os = require("os");
const path = require("path");
const prompts = require("prompts");
const semver = require("semver");
const { Command } = require("commander");
const { Octokit } = require("@octokit/core");

/**
 * The path to the cache folder.
 */
const CACHE_DIR = path.join(os.homedir(), ".config/create-tau-app");

/**
 * The downloaded releases cache folder.
 */
const DOWNLOAD_CACHE = path.join(CACHE_DIR, "releases");

/**
 * The latest version key.
 */
const LATEST_VERSION = "latest";

/**
 * The release cache file.
 */
const RELEASES_CACHE = path.join(CACHE_DIR, "releases.json");

/**
 * The release cache expiration in milliseconds.
 */
const RELEASES_CACHE_EXPIRES = 1000 * 60 * 60 * 4;

/**
 * Manages the process of generating a new application from a template.
 */
class Generator {
  /**
   * The use cache flag.
   *
   * @type {boolean}
   */
  #cache;

  /**
   * The GitHub client.
   */
  #github;

  /**
   * The verbose logging flag.
   *
   * @type {boolean}
   */
  #verbose;

  /**
   * Initializes the generator.
   *
   * @param {object}  options         The generator options.
   * @param {boolean} options.cache   Use caching?
   * @param {Octokit} options.github  The GitHub client.
   * @param {verbose} options.verbose Use verbose logging?
   */
  constructor({ cache, github, verbose }) {
    this.#cache = cache;
    this.#github = github;
    this.#verbose = verbose;
  }

  /**
   * Checks if the release cache exists and has not expired.
   *
   * @return {boolean} Returns `true` if usable, or `false` if not.
   */
  canUseReleaseCache() {
    if (fs.existsSync(RELEASES_CACHE)) {
      const modified = fs.statSync(RELEASES_CACHE).mtimeMs;
      const elapsed = Date.now() - modified;

      return elapsed < RELEASES_CACHE_EXPIRES;
    }

    return false;
  }

  /**
   * Customizes the unpacked template for the new application.
   *
   * @param {string} name         The name of the new application.
   * @param {string} templatePath The path to the template directory.
   */
  async customizeTemplate(name, templatePath) {
    const onCancel = () => this.exit(1, "Cancelling package generation.");
    const packageFile = path.join(templatePath, "package.json");
    const questions = [
      {
        initial: name,
        message: "Package name?",
        name: "name",
        validate: (value) => {
          if (!value.trim()) {
            return "A package name is required.";
          }

          return true;
        },
        type: "text",
      },
      {
        message: "Package author?",
        name: "author",
        validate: (value) => {
          if (!value.trim()) {
            return "An author is required.";
          }

          return true;
        },
        type: "text",
      },
      {
        message: "Package description?",
        name: "description",
        validate: (value) => {
          if (!value.trim()) {
            return "A package description is required.";
          }

          return true;
        },
        type: "text",
      },
    ];

    const responses = await prompts(questions, { onCancel });
    const packageInfo = jsonfile.readFileSync(packageFile);

    packageInfo.author = responses.author;
    packageInfo.description = responses.description;
    packageInfo.name = responses.name;

    delete packageInfo.keywords;
    delete packageInfo.bugs;
    delete packageInfo.repository;

    jsonfile.writeFileSync(packageFile, packageInfo, { spaces: 2 });
  }

  /**
   * Prints an error message to STDOUT.
   *
   * @param {*} arg... A message argument.
   */
  error(...args) {
    console.error(
      `${chalk.bold.red("[create-tau-app]")} ${chalk.gray(args.shift())}`,
      ...args
    );
  }

  /**
   * Prints an error to STDERR and exits.
   *
   * @param {number} status The exit status.
   * @param {*}      arg... A message argument.
   */
  exit(status, ...args) {
    this.error(...args);

    process.exit(status);
  }

  /**
   * Generates a new application.
   *
   * @param {object} options         The generator options.
   * @param {string} options.dir     The application directory path.
   * @param {string} options.name    The application name.
   * @param {string} options.version The template version to use.
   */
  async generate({ dir, name, version }) {
    if (fs.existsSync(dir)) {
      this.exit(1, "The target directory already exists.");
    }

    this.log(`Generating a new app using ${version}...`);
    this.prepareCache();

    // Find the appropriate template version.
    const releases = await this.getReleases();

    if (version === LATEST_VERSION) {
      version = releases.latest;
    }

    if (!releases.versions[version]) {
      this.exit(1, `The version, ${version}, does not exist.`);
    }

    this.log("Preparing the template...");

    // Download the release.
    const templatePath = await this.getTemplate(
      version,
      releases.versions[version]
    );

    // Unpack the release.
    const tempPath = await this.unpackTemplate(templatePath);

    // Customize the unpacked template.
    await this.customizeTemplate(name, tempPath);

    // Move the customized template to the desired location.
    await move(tempPath, dir);
  }

  /**
   * Returns the available releases.
   *
   * @return {object} The releases.
   */
  async getReleases() {
    // Use the cache, if possible.
    if (this.#cache && this.canUseReleaseCache()) {
      this.verbose("Using cached release data.");

      return jsonfile.readFileSync(RELEASES_CACHE);
    }

    // Get the current list of releases.
    const releases = {
      versions: {},
    };
    let response;

    this.verbose("Querying for available releases...");

    do {
      response = await this.#github.request(
        "GET /repos/kherge/js.tau/releases?per_page=100"
      );

      for (const release of response.data) {
        const url = release.zipball_url;
        const version = release.tag_name;

        if (release.draft || release.prerelease || !semver.valid(version)) {
          continue;
        }

        releases.versions[version] = url;
      }
    } while (response.data.length === 100);

    // Find the latest version.
    const latest = Object.keys(releases.versions).reduce((current, next) =>
      semver.gt(next, current) ? next : current
    );

    if (latest) {
      releases.latest = latest;
    }

    // Update the cache.
    this.verbose("Updating cache released data...");

    jsonfile.writeFileSync(RELEASES_CACHE, releases, { spaces: 2 });

    return releases;
  }

  /**
   * Downloads a template for a specific version.
   *
   * @param {string} version The version of the template.
   * @param {string} url     The download URL.
   *
   * @return {string} The path to the downloaded template file.
   */
  async getTemplate(version, url) {
    const filename = `${version}.zip`;
    const templatePath = path.join(DOWNLOAD_CACHE, filename);

    if (this.#cache && fs.existsSync(templatePath)) {
      this.verbose("Using cached template.");
    } else {
      this.verbose("Downloading template...");

      await download(url, DOWNLOAD_CACHE, {
        filename,
      });
    }

    return templatePath;
  }

  /**
   * Prints a message to STDOUT.
   *
   * @param {*} arg... A message argument.
   */
  log(...args) {
    console.log(
      `${chalk.bold.cyan("[create-tau-app]")} ${args.shift()}`,
      ...args
    );
  }

  /**
   * Prepares the cache directories.
   */
  prepareCache() {
    const ensureExists = (dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    };

    ensureExists(CACHE_DIR);
    ensureExists(DOWNLOAD_CACHE);
  }

  /**
   * Unpacks the template into a temporary directory.
   *
   * @param {string} templatePath The path to the template archive.
   *
   * @return {string} The path to the directory.
   */
  async unpackTemplate(templatePath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cta-"));
    const objects = await decompress(templatePath, tempDir);

    // Use the inner folder for the template.
    const innerDir = path.join(tempDir, objects[0].path);

    return innerDir;
  }

  /**
   * Prints a verbose message to STDOUT.
   *
   * @param {*} arg... A message argument.
   */
  verbose(...args) {
    if (this.#verbose) {
      console.log(
        `${chalk.bold.gray("[create-tau-app]")} ${chalk.gray(args.shift())}`,
        ...args
      );
    }
  }
}

/**
 * Processes the command line arguments to generate a new application.
 *
 * @param {string}   name    The name of the application.
 * @param {string}   version The version of the application.
 * @param {string[]} args    The command line arguments.
 */
const command = async (name, version, args) => {
  new Command(name)
    .version(version, "-X", "Print the version of this tool.")
    .description("Creates a new application using Tau.")
    .arguments("<dir>")
    .helpOption("-h, --help", "Displays this help screen.")
    .option("-n, --name <name>", "The name of your new application.")
    .option("-u, --update", "Force update the cache.")
    .option(
      "-v, --version <version>",
      "The version of the template.",
      LATEST_VERSION
    )
    .option("-V, --verbose", "Enable verbose logging.", false)
    .action(async (dir, options) => {
      await new Generator({
        cache: !options.update,
        github: new Octokit(),
        verbose: options.verbose,
      }).generate({
        dir,
        name: options.name ?? dir,
        version: options.version,
      });
    })
    .parseAsync(args)
    .catch((reason) => {
      console.error(chalk.red("The package could not be generated.\n"));
      console.error(chalk.red(reason.stack));
      process.exit(1);
    });
};

module.exports = command;
