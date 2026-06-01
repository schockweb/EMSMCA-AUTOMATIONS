with open('/Users/mariamahon/Desktop/EMS AUTOMATION/EMSMCA-AUTOMATIONS/frontend/src/pages/crew/ProviderAdminDashboard.tsx', 'r') as f:
    content = f.read()

import re
# The broken part looks like:
#                 </div>
#               )}
#           )}
#             </div>
# </main>

# We want:
#                 </div>
#               )}
#             </div>
#           )}
# </main>

content = content.replace("                </div>\n              )}\n          )}\n            </div>\n</main>", "                </div>\n              )}\n            </div>\n          )}\n</main>")

# Handle case where the previous sed messed it up differently
content = content.replace("              )}\n          )}\n            </div>\n</main>", "              )}\n            </div>\n          )}\n</main>")

with open('/Users/mariamahon/Desktop/EMS AUTOMATION/EMSMCA-AUTOMATIONS/frontend/src/pages/crew/ProviderAdminDashboard.tsx', 'w') as f:
    f.write(content)
