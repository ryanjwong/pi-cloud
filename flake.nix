{
  description = "pi-cloud: a hosted control plane and runners for Pi Durable agents";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

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
            hash = if pkgs.stdenv.hostPlatform.isDarwin then "sha256-2CtuP6BBTkZ0IO4Y99F0FGQtgueirVMw54Ek9/uLmrg=" else "sha256-PZ3+U9piIYEe+ntoJyxUyexKN76AJ6r+jbNL+861+gA=";
          };
          dontFixup = true;
        });
    in
    {
      packages = forAllSystems (pkgs: rec {
        pi-cloud = workspace pkgs {
          pname = "pi-cloud";
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/pi-cloud $out/bin
            cp -r . $out/lib/pi-cloud
            node=${pkgs.nodejs_22}/bin/node
            root=$out/lib/pi-cloud
            build="--set PI_CLOUD_BUILD ${self.shortRev or self.dirtyShortRev or "dirty"}"
            makeWrapper $node $out/bin/pi-cloud $build --add-flags $root/packages/cli/src/main.ts --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.sops pkgs.age pkgs.git ]}
            makeWrapper $node $out/bin/pi-cloud-server $build --add-flags $root/apps/local/src/main.ts
            makeWrapper $node $out/bin/pi-cloud-control $build --add-flags $root/apps/local/src/control-plane.ts
            makeWrapper $node $out/bin/pi-cloud-runner $build --add-flags $root/apps/local/src/runner.ts
            makeWrapper $node $out/bin/pi-cloud-config $build --add-flags $root/apps/local/src/config.ts
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
          deploy-cloudflare = {
            type = "app";
            program = "${pkgs.writeShellScript "pi-cloud-deploy-cloudflare" ''exec ${pkg}/bin/pi-cloud deploy cloudflare "$@"''}";
          };
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
      } // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (nixpkgs.lib.mapAttrs' (name: value: nixpkgs.lib.nameValuePair "nixos-${name}" value)
        (import ./nix/tests.nix { inherit pkgs; module = self.nixosModules.default; })));

      devShells = forAllSystems (pkgs:
        let
          checkout = name: script: pkgs.writeShellScriptBin name ''
            exec ${pkgs.nodejs_22}/bin/node "''${PI_CLOUD_ROOT:?enter the dev shell from a pi-cloud checkout}/${script}" "$@"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.nixpkgs-fmt pkgs.sops pkgs.age pkgs.ssh-to-age pkgs.litestream ]
              ++ pkgs.lib.mapAttrsToList checkout {
              pi-cloud = "packages/cli/src/main.ts";
              pi-cloud-server = "apps/local/src/main.ts";
              pi-cloud-control = "apps/local/src/control-plane.ts";
              pi-cloud-runner = "apps/local/src/runner.ts";
              pi-cloud-config = "apps/local/src/config.ts";
            };
            shellHook = ''
              r="''${PI_CLOUD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
              unset PI_CLOUD_ROOT
              [ -f "$r/packages/cli/src/main.ts" ] && export PI_CLOUD_ROOT="$r"
              unset r
              echo "pi-cloud dev shell: node $(node --version), pnpm $(pnpm --version), $(sops --version | head -1)"
              echo "pi-cloud and pi-cloud-server run ''${PI_CLOUD_ROOT:-nothing: not in a pi-cloud checkout}"
            '';
          };
        });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);

      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.pi-cloud;
          programs = { all-in-one = "pi-cloud-server"; control-plane = "pi-cloud-control"; runner = "pi-cloud-runner"; };
          backup = cfg.backup.enable && cfg.role != "runner";
          docker = cfg.role != "control-plane" && config.virtualisation.docker.enable;
          database = "/var/lib/pi-cloud/pi-cloud.sqlite";
          litestreamConfig = pkgs.writeText "pi-cloud-litestream.yml" (builtins.toJSON {
            dbs = [{
              path = database;
              replicas = [ ({ url = cfg.backup.url; } // lib.optionalAttrs (cfg.backup.endpoint != null) { endpoint = cfg.backup.endpoint; }) ];
            }];
          });
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
                api = { provider = "docker"; user = "1000:1000"; repository = { url = "https://github.com/acme/api.git"; }; credential = "GITHUB_TOKEN"; setup = [ "pnpm install" ]; };
              }'';
              description = "Operator sandbox templates by name, the only ones sessions can use (`pi-cloud chat --sandbox api`). Read by the control plane, so not for `role = \"runner\"`. Docker templates need `virtualisation.docker.enable` on the runner host.";
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
            backup = {
              enable = lib.mkEnableOption ''
                streaming backups of the control plane's database with Litestream: every change to pi-cloud.sqlite
                is shipped to object storage within a second, and a host that starts without the file restores it
              '';
              url = lib.mkOption {
                type = lib.types.str;
                example = "s3://my-bucket/pi-cloud";
                description = "Litestream replica URL (S3, R2, GCS, Azure, SFTP, ...).";
              };
              endpoint = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "https://<account-id>.r2.cloudflarestorage.com";
                description = "S3-compatible endpoint, e.g. Cloudflare R2.";
              };
              environmentFile = lib.mkOption {
                type = lib.types.nullOr lib.types.path;
                default = null;
                example = lib.literalExpression "config.sops.templates.litestream.path";
                description = "Environment file with LITESTREAM_ACCESS_KEY_ID and LITESTREAM_SECRET_ACCESS_KEY.";
              };
            };
          };

          config = lib.mkIf cfg.enable {
            assertions = [{
              assertion = cfg.role != "runner" || cfg.sandboxTemplates == { };
              message = "services.pi-cloud.sandboxTemplates is read by the control plane; set it on the control-plane or all-in-one host.";
            }];
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
              path = cfg.sandboxPackages ++ lib.optional docker config.virtualisation.docker.package;
              serviceConfig = {
                ExecStart =
                  if backup then "${pkgs.litestream}/bin/litestream replicate -config ${litestreamConfig} -exec ${cfg.package}/bin/${programs.${cfg.role}}"
                  else "${cfg.package}/bin/${programs.${cfg.role}}";
                ExecStartPre = lib.optional backup
                  "${pkgs.litestream}/bin/litestream restore -config ${litestreamConfig} -if-db-not-exists -if-replica-exists ${database}";
                EnvironmentFile = lib.optional (backup && cfg.backup.environmentFile != null) cfg.backup.environmentFile;
                DynamicUser = true;
                SupplementaryGroups = lib.optional docker "docker";
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
