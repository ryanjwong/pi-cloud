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
          packages = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.nixpkgs-fmt ];
          shellHook = ''
            echo "pi-cloud dev shell: node $(node --version), pnpm $(pnpm --version)"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
