// The double-click entry point. `npm start` needs a terminal that then has to
// stay open for the app's whole session; this is a windowless .exe that starts
// Electron and exits, leaving the app in the tray where it belongs.
//
// It is deliberately a launcher rather than a packaged build: the app still
// runs from this checkout, with this .venv and this model, so a `git pull`
// updates it and nothing has to be re-installed. The exe lives in the repo
// root and finds everything relative to itself.
//
// Built by scripts/make-launcher.js. See launcher/README.md.

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class Launcher
{
    const string Title = "Screen Prompt 2";

    [STAThread]
    static int Main(string[] argv)
    {
        // BaseDirectory always ends in a backslash, which would escape the
        // closing quote when the path is quoted on Electron's command line.
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string electron = Path.Combine(root, @"node_modules\electron\dist\electron.exe");

        if (!File.Exists(electron))
        {
            // The one failure a user will actually hit: a fresh clone, or a
            // node_modules that never finished. Silence here would look like
            // double-clicking did nothing at all.
            MessageBox.Show(
                "Electron is not installed in this folder yet.\n\n" +
                "Open a terminal here and run:\n" +
                "    npm install\n" +
                "    npm run setup\n\n" + root,
                Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        // Electron needs the app directory as its first argument — an
        // unpackaged build launched without one just opens its own demo window.
        // Anything passed to this exe is forwarded, so a shortcut can add
        // --hidden and start straight into the tray.
        StringBuilder args = new StringBuilder();
        args.Append(Quote(root));
        foreach (string arg in argv)
        {
            args.Append(' ').Append(Quote(arg));
        }

        ProcessStartInfo psi = new ProcessStartInfo(electron, args.ToString());
        psi.UseShellExecute = false;   // no shell, so no console window flashes
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = root;

        try
        {
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not start " + Title + ":\n\n" + ex.Message,
                Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 3;
        }

        // Exiting immediately is the point: the app is a separate process and
        // outlives this one, so nothing lingers in Task Manager on our behalf.
        return 0;
    }

    // Windows re-splits the command line inside the child, so an argument with
    // a space has to arrive quoted. Backslashes immediately before a quote are
    // doubled, per the rules CommandLineToArgvW applies coming back out.
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;

        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < arg.Length; i++)
        {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }

            if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
            if (arg[i] == '"') { sb.Append('\\', slashes * 2 + 1); }
            else { sb.Append('\\', slashes); }
            sb.Append(arg[i]);
        }
        return sb.Append('"').ToString();
    }
}
