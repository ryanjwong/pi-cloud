{ pkgs, module }:
let
  inherit (pkgs) lib;

  apiKey = "vm-api-key";
  runnerSecret = "vm-runner-secret";

  secretFiles = values: {
    system.activationScripts.pi-cloud-secrets = lib.concatStrings (lib.mapAttrsToList
      (name: value: ''
        install -D -m 0400 /dev/stdin /run/keys/${name} <<< ${lib.escapeShellArg value}
      '')
      values);
  };
  secretPaths = names: lib.genAttrs names (name: "/run/keys/${name}");

  base = {
    imports = [ module ];
    networking.firewall.enable = false;
    environment.systemPackages = [ pkgs.curl pkgs.jq ];
    virtualisation.memorySize = 2048;
  };

  serverSecrets = {
    PI_CLOUD_API_KEYS = apiKey;
    PI_CLOUD_CREDENTIAL_KEY = "vm-credential-key";
    ANTHROPIC_API_KEY = "vm-anthropic-key";
  };

  curl = "curl -sf -H 'authorization: Bearer ${apiKey}' -H 'content-type: application/json'";

  test = name: args: pkgs.testers.runNixOSTest ({ name = "pi-cloud-${name}"; } // args);
in
{
  all-in-one = test "all-in-one" {
    nodes.server = {
      imports = [ base (secretFiles serverSecrets) ];
      services.pi-cloud = {
        enable = true;
        settings = { HOST = "0.0.0.0"; PORT = "8787"; };
        secrets = secretPaths (builtins.attrNames serverSecrets);
      };
    };
    nodes.client = base;
    testScript = ''
      start_all()
      server.wait_for_unit("pi-cloud.service")
      server.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health")
      client.wait_until_succeeds("curl -sf http://server:8787/health")

      client.succeed("test $(curl -s -o /dev/null -w '%{http_code}' http://server:8787/v1/sessions) = 401")
      client.succeed("test $(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer wrong' http://server:8787/v1/sessions) = 401")

      session = client.succeed("${curl} -d '{\"title\":\"in a vm\"}' http://server:8787/v1/sessions | jq -r .id").strip()

      server.succeed("systemctl restart pi-cloud.service")
      server.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health")
      client.succeed(f"${curl} http://server:8787/v1/sessions/{session} | jq -e '.title == \"in a vm\"'")

      pid = server.succeed("systemctl show -p MainPID --value pi-cloud.service").strip()
      server.succeed(f"test $(stat -c %U /proc/{pid}) != root")
      server.fail(f"tr '\\0' '\\n' < /proc/{pid}/environ | grep -E 'vm-api-key|vm-credential-key|vm-anthropic-key'")
      server.fail("grep -r -l -E 'vm-api-key|vm-anthropic-key' /etc/systemd/system/pi-cloud.service")
    '';
  };

  fail-closed = test "fail-closed" {
    nodes.open = {
      imports = [ base ];
      services.pi-cloud = { enable = true; settings = { HOST = "0.0.0.0"; }; };
    };
    nodes.control = {
      imports = [ base ];
      services.pi-cloud = { enable = true; role = "control-plane"; settings = { HOST = "0.0.0.0"; }; };
    };
    testScript = ''
      start_all()
      open.wait_until_succeeds("journalctl -u pi-cloud.service | grep -q 'is reachable from other machines'")
      open.fail("curl -sf http://127.0.0.1:8787/health")
      control.wait_until_succeeds("journalctl -u pi-cloud.service | grep -q 'to run the control plane on its own'")
      control.fail("curl -sf http://127.0.0.1:8787/health")
    '';
  };

  split = test "split" {
    nodes.control = {
      imports = [ base (secretFiles (serverSecrets // { PI_CLOUD_RUNNER_SECRET = runnerSecret; })) ];
      services.pi-cloud = {
        enable = true;
        role = "control-plane";
        settings = { HOST = "0.0.0.0"; PORT = "8787"; PUBLIC_URL = "http://control:8787"; };
        secrets = secretPaths [ "PI_CLOUD_API_KEYS" "PI_CLOUD_CREDENTIAL_KEY" "PI_CLOUD_RUNNER_SECRET" ];
      };
    };
    nodes.runner = {
      imports = [ base (secretFiles { PI_CLOUD_RUNNER_SECRET = runnerSecret; }) ];
      services.pi-cloud = {
        enable = true;
        role = "runner";
        settings = { CONTROL_PLANE_URL = "http://control:8787"; };
        secrets = secretPaths [ "PI_CLOUD_RUNNER_SECRET" ];
      };
    };
    testScript = ''
      start_all()
      control.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health")
      runner.wait_for_unit("pi-cloud.service")

      session = control.succeed("${curl} -d '{}' http://127.0.0.1:8787/v1/sessions | jq -r .id").strip()
      control.succeed(f"${curl} -d '{{\"content\":\"hello from a vm\"}}' http://127.0.0.1:8787/v1/sessions/{session}/messages")
      control.wait_until_succeeds(
        f"${curl} 'http://127.0.0.1:8787/v1/sessions/{session}/entries?limit=10' | jq -e '.entries | map(.kind) | index(\"pi.user\") != null'"
      )
    '';
  };

  backup = test "backup" {
    nodes.storage = {
      imports = [ base ];
      services.minio = {
        enable = true;
        rootCredentialsFile = pkgs.writeText "minio-credentials" ''
          MINIO_ROOT_USER=minioadmin
          MINIO_ROOT_PASSWORD=minioadmin
        '';
      };
      environment.systemPackages = [ pkgs.minio-client ];
    };
    nodes.server = {
      imports = [ base (secretFiles (serverSecrets // { "litestream.env" = "LITESTREAM_ACCESS_KEY_ID=minioadmin\nLITESTREAM_SECRET_ACCESS_KEY=minioadmin\n"; })) ];
      services.pi-cloud = {
        enable = true;
        settings = { HOST = "0.0.0.0"; PORT = "8787"; };
        secrets = secretPaths (builtins.attrNames serverSecrets);
        backup = {
          enable = true;
          url = "s3://pi-cloud/server";
          endpoint = "http://storage:9000";
          environmentFile = "/run/keys/litestream.env";
        };
      };
      systemd.services.pi-cloud.wantedBy = lib.mkForce [ ];
    };
    testScript = ''
      storage.start()
      storage.wait_for_unit("minio.service")
      storage.wait_for_open_port(9000)
      storage.succeed("mc alias set local http://127.0.0.1:9000 minioadmin minioadmin && mc mb local/pi-cloud")

      server.start()
      server.succeed("systemctl start pi-cloud.service")
      server.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health")
      session = server.succeed("${curl} -d '{\"title\":\"backed up\"}' http://127.0.0.1:8787/v1/sessions | jq -r .id").strip()
      storage.wait_until_succeeds("mc ls --recursive local/pi-cloud/server | grep -q .")

      server.succeed("sleep 3 && systemctl stop pi-cloud.service")
      server.succeed("rm -f /var/lib/private/pi-cloud/pi-cloud.sqlite*")
      server.succeed("systemctl start pi-cloud.service")
      server.wait_until_succeeds("curl -sf http://127.0.0.1:8787/health")
      server.succeed(f"${curl} http://127.0.0.1:8787/v1/sessions/{session} | jq -e '.title == \"backed up\"'")
    '';
  };
}
