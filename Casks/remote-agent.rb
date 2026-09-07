# Cask for the Remote Agent GUI. This repo is its own tap; the release
# workflow renders VERSION/SHA256 from the uploaded DMGs and commits the
# result back here after tagging.
#
#   brew tap brandonisagoon/remote-agent https://github.com/brandonisagoon/remote-agent
#   brew install --cask remote-agent
cask "remote-agent" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "0000000000000000000000000000000000000000000000000000000000000001",
         intel: "0000000000000000000000000000000000000000000000000000000000000002"

  url "https://github.com/brandonisagoon/remote-agent/releases/download/v#{version}/remote-agent-#{version}-#{arch}.dmg"
  name "Remote Agent"
  desc "GUI for the Remote Agent server: settings, status checklist, sessions"
  homepage "https://github.com/brandonisagoon/remote-agent"

  depends_on macos: :big_sur

  app "Remote Agent.app"

  zap trash: [
    "~/Library/Application Support/Remote Agent",
    "~/Library/Preferences/dev.remote-agent.desktop.plist",
  ]
end
