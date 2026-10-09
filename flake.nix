{
  description = "pi-cloud: a hosted control plane and runners for Pi Durable agents";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Node 22.18+ runs the workspace's TypeScript directly, so the package is the sources plus node_modules.
      workspace = pkgs: { pname, buildPhase ? "runHook preBuild; runHook postBuild", installPhase, doCheck ? false }:
        let
          nodejs = pkgs.nodejs_22;
          pnpm = pkgs.pnpm_10;
        in
        pkgs.stdenv.mkDerivation (finalAttrs: {
          inherit pname buildPhase installPhase;
          version = "0.1.0";
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: _type:
              !(builtins.elem (baseNameOf path) [ "node_modules" ".data" ".alchemy" ".wrangler" "result" ]);
          };
          nativeBuildInputs = [ nodejs pnpm pkgs.pnpmConfigHook pkgs.makeWrapper ];
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) src version;
            pname = "pi-cloud";
            inherit pnpm;
            fetcherVersion = 3;
            # Not yet computed: the first `nix build` prints the real hash; paste it here. Update it whenever
            # pnpm-lock.yaml changes.
            hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
          };
          dontFixup = true;
        });
    in
    {
      packages = forAllSystems (pkgs: rec {
        # The whole workspace with its dependencies, plus entry points:
        #   pi-cloud          terminal client
        #   pi-cloud-server   control plane and runner in one process (state in $DATA_DIR)
        #   pi-cloud-control  control plane alone, waking runners over HTTP ($RUNNER_URL)
        #   pi-cloud-runner   runner host alone, attaching to $CONTROL_PLANE_URL
        #   pi-cloud-config   which settings and secrets are set, and where from
        pi-cloud = workspace pkgs {
          pname = "pi-cloud";
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/pi-cloud $out/bin
            cp -r . $out/lib/pi-cloud
            node=${pkgs.nodejs_22}/bin/node
            root=$out/lib/pi-cloud
            makeWrapper $node $out/bin/pi-cloud --add-flags $root/packages/cli/src/main.ts
            makeWrapper $node $out/bin/pi-cloud-server --add-flags $root/apps/local/src/main.ts
            makeWrapper $node $out/bin/pi-cloud-control --add-flags $root/apps/local/src/control-plane.ts
            makeWrapper $node $out/bin/pi-cloud-runner --add-flags $root/apps/local/src/runner.ts
            makeWrapper $node $out/bin/pi-cloud-config --add-flags $root/apps/local/src/config.ts
            runHook postInstall
          '';
        };
        default = pi-cloud;
      });

      apps = forAllSystems (pkgs:
        let pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-cloud; in {
          default = { type = "app"; program = "${pkg}/bin/pi-cloud-server"; };
          cli = { type = "app"; program = "${pkg}/bin/pi-cloud"; };
          control-plane = { type = "app"; program = "${pkg}/bin/pi-cloud-control"; };
          runner = { type = "app"; program = "${pkg}/bin/pi-cloud-runner"; };
        });

      checks = forAllSystems (pkgs: {
        typecheck = workspace pkgs {
          pname = "pi-cloud-typecheck";
          buildPhase = "runHook preBuild; pnpm typecheck; runHook postBuild";
          installPhase = "touch $out";
        };
        test = workspace pkgs {
          pname = "pi-cloud-test";
          buildPhase = "runHook preBuild; HOME=$TMPDIR pnpm test; runHook postBuild";
          installPhase = "touch $out";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.nixpkgs-fmt pkgs.sops pkgs.age pkgs.ssh-to-age ];
          shellHook = ''
            echo "pi-cloud dev shell: node $(node --version), pnpm $(pnpm --version), $(sops --version | head -1)"
            echo "run with secrets: sops exec-env secrets.yaml 'pnpm start'"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);

      # Run pi-cloud as a systemd service. Secrets are files (typically from sops-nix) handed to the service with
      # systemd's LoadCredential, so they are readable only by the service, never appear in the Nix store or the
      # environment, and are read through the same typed config as everywhere else.
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.pi-cloud;
          programs = { all-in-one = "pi-cloud-server"; control-plane = "pi-cloud-control"; runner = "pi-cloud-runner"; };
        in
        {
          options.services.pi-cloud = {
            enable = lib.mkEnableOption "pi-cloud";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-cloud;
              description = "The pi-cloud package.";
            };
            role = lib.mkOption {
              type = lib.types.enum [ "all-in-one" "control-plane" "runner" ];
              default = "all-in-one";
              description = "Which server to run.";
            };
            settings = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              example = { PORT = "8787"; GITHUB_MENTION = "@pi"; SANDBOX_SECRETS = "GITHUB_TOKEN"; };
              description = "Non-secret settings, as environment variables. See `pi-cloud-config` for the list.";
            };
            sandboxTemplates = lib.mkOption {
              type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
              default = { };
              example = lib.literalExpression ''{
                api = { provider = "local"; repository = { url = "https://github.com/acme/api.git"; credential = "GITHUB_TOKEN"; }; setup = [ "pnpm install" ]; };
              }'';
              description = "Sandbox templates by name, available to every session (`pi-cloud chat --sandbox api`).";
            };
            sandboxPackages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = with pkgs; [ bash coreutils findutils gnugrep gnused gitMinimal ];
              description = "Tools on the PATH of sandbox commands (local sandboxes).";
            };
            secrets = lib.mkOption {
              type = lib.types.attrsOf lib.types.path;
              default = { };
              example = lib.literalExpression ''{ ANTHROPIC_API_KEY = config.sops.secrets.ANTHROPIC_API_KEY.path; }'';
              description = "Secret files by setting name, e.g. paths from sops-nix.";
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.pi-cloud = {
              description = "pi-cloud ${cfg.role}";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              environment = { DATA_DIR = "/var/lib/pi-cloud"; }
                // lib.optionalAttrs (cfg.sandboxTemplates != { }) {
                  SANDBOX_TEMPLATES_FILE = pkgs.writeText "pi-cloud-sandbox-templates.json" (builtins.toJSON cfg.sandboxTemplates);
                }
                // cfg.settings;
              path = cfg.sandboxPackages;
              serviceConfig = {
                ExecStart = "${cfg.package}/bin/${programs.${cfg.role}}";
                DynamicUser = true;
                StateDirectory = "pi-cloud";
                LoadCredential = lib.mapAttrsToList (name: path: "${name}:${path}") cfg.secrets;
                Restart = "on-failure";
                NoNewPrivileges = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
              };
            };
          };
        };
    };
}
