# Formula for the remote-agent CLI. This repo is its own tap; the release
# workflow renders VERSION/SHA256 and commits the result back here after
# tagging.
#
#   brew tap brandonisagoon/remote-agent https://github.com/brandonisagoon/remote-agent
#   brew install remote-agent
class RemoteAgent < Formula
  desc "Control plane for acpx-backed coding-agent sessions driven by Linear"
  homepage "https://github.com/brandonisagoon/remote-agent"
  url "https://github.com/brandonisagoon/remote-agent/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "oven-sh/bun/bun"
  depends_on "cloudflared"

  def install
    # The CLI runs straight from the source tree; ship it whole and exec via
    # the repo's own wrapper (which resolves symlinks back to libexec).
    libexec.install Dir["*", ".??*"] - [".git"]
    bin.install_symlink libexec/"bin/remote-agent"
  end

  test do
    assert_match "remote-agent", shell_output("#{bin}/remote-agent --help")
  end
end
